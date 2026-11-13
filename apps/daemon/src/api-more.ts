/**
 * API handlers added for the PWA screens: whoami, worktree merge / PR, channel connect, fs.list,
 * instruction file writes, alerts, updates, quorum, custom roles, owners and linked identities.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { effectiveRoleDef, normalizePrincipal, type RoleOverride } from '@beamhop/authz';
import {
  AlertRulesPatch,
  BeamhopError,
  BUILTIN_ROLES,
  expandHome,
  RoleDef,
  RoleName,
  type WhoamiView,
} from '@beamhop/core';
import { type Daemon, LOCAL_OWNER } from './daemon.ts';
import { listDirs } from './fs-list.ts';
import {
  checkBranch,
  commitPending,
  compareUrl,
  defaultBase,
  mergeBranch,
  pushBranch,
  remoteUrl,
  repoOfWorktree,
} from './git-ops.ts';
import type { CallContext, Handler } from './rpc-server.ts';
import { absPath, isDenied, within } from './rules.ts';
import { gitTopLevel, removeWorktree } from './worktree.ts';

const OK = { ok: true as const };

/** Harness instruction files (relative to a mount) that `agent.instructions` reads and the PWA may edit. */
export const INSTRUCTION_FILES: { file: string; harness: string }[] = [
  { file: 'CLAUDE.md', harness: 'claude' },
  { file: '.claude/CLAUDE.md', harness: 'claude' },
  { file: 'AGENTS.md', harness: 'codex' },
  { file: 'GEMINI.md', harness: 'gemini' },
  { file: '.codex/config.toml', harness: 'codex' },
  { file: '.pi/SYSTEM.md', harness: 'pi' },
  { file: 'opencode.json', harness: 'opencode' },
];

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

const personOf = (people: Record<string, string[]>, principal: string): string | undefined => {
  const n = normalizePrincipal(principal);
  return Object.entries(people).find(([, ps]) => ps.some((p) => normalizePrincipal(p) === n))?.[0];
};

type Ctx = CallContext;

export type MoreMethod =
  | 'system.whoami'
  | 'session.merge'
  | 'session.openPr'
  | 'channel.connect'
  | 'channel.disconnect'
  | 'fs.list'
  | 'agent.instructionsWrite'
  | 'alerts.get'
  | 'alerts.set'
  | 'updates.get'
  | 'updates.set'
  | 'approval.quorumGet'
  | 'approval.quorumSet'
  | 'role.define'
  | 'role.delete'
  | 'owner.list'
  | 'principal.list'
  | 'principal.unlink';

export interface MoreDeps {
  principal(ctx: Ctx): string;
}

export const moreHandlers = (d: Daemon, deps: MoreDeps) => {
  const whoami = (ctx: Ctx): WhoamiView => {
    const g = d.global();
    const local = ctx.caller === 'local' || ctx.transport === 'direct';
    if (local) {
      const person = personOf(g.people, LOCAL_OWNER);
      return { principal: LOCAL_OWNER, role: 'owner', via: 'local', ...(person ? { person } : {}) };
    }
    if (ctx.caller.startsWith('nostr:')) {
      const npub = ctx.caller.slice(6);
      const dev = d.pairing.activeDevices().find((x) => x.pubkey === npub);
      if (dev)
        return {
          principal: LOCAL_OWNER,
          role: 'owner',
          via: 'device',
          displayName: dev.name,
          device: { id: dev.id, name: dev.name },
          ...(personOf(g.people, LOCAL_OWNER) ? { person: personOf(g.people, LOCAL_OWNER)! } : {}),
        };
    }
    const owner = d.ownerPrincipals().includes(normalizePrincipal(ctx.caller));
    const person = personOf(g.people, ctx.caller);
    const n = normalizePrincipal(ctx.caller);
    const grant = Object.entries(g.grants).find(([p]) => normalizePrincipal(p) === n)?.[1];
    return {
      principal: ctx.caller,
      role: owner ? 'owner' : (grant ?? 'viewer'),
      via: 'nostr',
      ...(person ? { person } : {}),
    };
  };

  const assertOwner = (ctx: Ctx) => {
    if (whoami(ctx).role !== 'owner') throw new BeamhopError('forbidden', 'only owners can do that');
  };

  const sessionWorktree = (id: string) => {
    const rec = d.store.sessions.require(id);
    if (!rec.worktree) throw new BeamhopError('invalid_input', 'this session has no git worktree');
    return { rec, wt: rec.worktree.path, branch: rec.worktree.branch };
  };

  /** Repositories of the agent's rw git mounts, resolved outside any worktree (wave C GIT-1). */
  const agentRepos = async (agent: string): Promise<string[]> => {
    const a = d.config.agents.get(agent);
    const tops = await Promise.all(
      (a?.mounts ?? []).filter((m) => m.mode === 'rw').map((m) => gitTopLevel(absPath(expandHome(m.path)))),
    );
    return tops.filter((t): t is string => !!t);
  };

  const quorumView = () => {
    const policy = d.approvals.policy();
    return {
      quorum: d.global().approvals.quorum,
      approvers: policy.quorumFor({ requestedBy: { principal: 'system:quorum', role: 'system' } }).pool,
    };
  };

  const updatesView = () => {
    const u = d.global().updates;
    return { catalogAuto: u.catalogAuto, appPrompt: u.appPrompt };
  };

  /** Validate a role patch field by field (unset fields keep their base). */
  const parseRolePatch = (raw: Record<string, unknown>): RoleOverride => {
    const name = RoleName.safeParse(raw.name);
    if (!name.success) throw new BeamhopError('invalid_input', 'role name: lowercase letters, digits and -');
    const shape = RoleDef.shape as Record<
      string,
      { safeParse(v: unknown): { success: boolean; data?: unknown } }
    >;
    const out: Record<string, unknown> = { name: name.data };
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'name' || v === undefined) continue;
      const field = shape[k];
      if (!field) throw new BeamhopError('invalid_input', `unknown role field ${k}`);
      if (k === 'tools' || k === 'budget') {
        if (typeof v !== 'object' || v === null || Array.isArray(v))
          throw new BeamhopError('invalid_input', `role.${k} must be an object`);
      }
      const r = field.safeParse(v);
      if (!r.success) throw new BeamhopError('invalid_input', `invalid role field ${k}`);
      // Keep only the keys the caller set inside tools/budget (defaults would reset the base).
      out[k] =
        k === 'tools' || k === 'budget'
          ? Object.fromEntries(
              Object.keys(v as object).map((x) => [x, (r.data as Record<string, unknown>)[x]]),
            )
          : r.data;
    }
    return out as RoleOverride;
  };

  const roleInUse = (name: string): string | undefined => {
    const g = d.global();
    for (const [p, r] of Object.entries(g.grants)) if (r === name) return p;
    for (const a of d.config.agents.list()) {
      for (const [p, r] of Object.entries(a.grants)) if (r === name) return `${p} on ${a.name}`;
      for (const m of a.memberships) if (m.defaultRole === name) return `${a.name} membership ${m.target}`;
    }
    return undefined;
  };

  const h: { [M in MoreMethod]: Handler<M> } = {
    'system.whoami': async (_p, ctx) => whoami(ctx),

    // ── worktrees ──
    'session.merge': async ({ id, base, deleteBranch }, ctx) => {
      assertOwner(ctx);
      const { rec, wt, branch } = sessionWorktree(id);
      if (rec.status === 'running')
        throw new BeamhopError('conflict', 'the session is running; wait or stop it first');
      if (deleteBranch && d.sessions.live(id))
        throw new BeamhopError('conflict', 'stop the session before deleting its branch');
      const repo = await repoOfWorktree(wt, { repos: await agentRepos(rec.agent), branch });
      await checkBranch(repo, branch);
      if (base) await checkBranch(repo, base);
      await commitPending(wt, `beamhop: ${rec.title}`.slice(0, 200));
      const r = await mergeBranch({
        repo,
        branch,
        ...(base ? { base } : {}),
        message: `Merge ${branch} (beamhop session ${id})`,
      });
      if (deleteBranch) {
        await removeWorktree(repo, wt);
        const { execFile } = await import('node:child_process');
        await new Promise<void>((res) =>
          execFile('git', ['-C', repo, 'branch', '-D', branch], { windowsHide: true }, () => res()),
        );
      }
      d.audit({
        type: 'session.merged',
        severity: 'security',
        summary: `Merged ${branch} into ${r.base}${r.fastForward ? ' (fast-forward)' : ''} for session ${id}`,
        actor: deps.principal(ctx),
        agent: rec.agent,
        data: { session: id, branch, base: r.base, commit: r.commit },
      });
      d.sessions.event(id, {
        kind: 'system',
        text: `Merged ${branch} into ${r.base} (${r.commit.slice(0, 10)}).`,
      });
      return { branch, base: r.base, commit: r.commit, fastForward: r.fastForward };
    },
    'session.openPr': async ({ id, remote, base }, ctx) => {
      assertOwner(ctx);
      const { rec, wt, branch } = sessionWorktree(id);
      if (rec.status === 'running')
        throw new BeamhopError('conflict', 'the session is running; wait or stop it first');
      const repo = await repoOfWorktree(wt, { repos: await agentRepos(rec.agent), branch });
      await checkBranch(repo, branch);
      const url = await remoteUrl(repo, remote);
      const b = base ? await checkBranch(repo, base) : ((await defaultBase(repo, remote)) ?? 'main');
      await commitPending(wt, `beamhop: ${rec.title}`.slice(0, 200));
      const compare = compareUrl(url, b, branch);
      const by = deps.principal(ctx);
      const approval = await d.approvals.requestAction({
        agent: rec.agent,
        sessionId: id,
        requestedBy: { principal: by, displayName: 'owner', role: 'owner' },
        tool: 'git.push',
        title: `Push ${branch} to ${remote}`,
        input: {
          command: `git push ${remote} ${branch}`,
          remote,
          // Not `url`: that key means "a web request" to approval UIs (a remote may be a path).
          remoteUrl: url,
          branch,
          base: b,
          ...(compare ? { compareUrl: compare } : {}),
        },
        risk: 'medium',
        run: async () => {
          await pushBranch(wt, remote, branch);
          d.audit({
            type: 'session.pushed',
            severity: 'security',
            summary: `Pushed ${branch} to ${remote} (${url}) for session ${id}`,
            actor: by,
            agent: rec.agent,
            data: { session: id, branch, remote, url, ...(compare ? { compareUrl: compare } : {}) },
          });
          d.sessions.event(id, {
            kind: 'system',
            text: `Pushed ${branch} to ${remote}.${compare ? ` Open a pull request: ${compare}` : ''}`,
          });
        },
      });
      return { branch, base: b, remote, ...(compare ? { compareUrl: compare } : {}), approval };
    },

    // ── channels ──
    'channel.connect': async ({ name }, ctx) => {
      d.assertNotPanic();
      d.config.channels.require(name);
      const cfg = d.config.channels.update(name, (c) => ({ ...c, enabled: true }));
      await d.channels.connect(cfg).catch(() => {});
      d.audit({
        type: 'channel.connect',
        severity: 'info',
        summary: `Channel ${name} connected`,
        actor: deps.principal(ctx),
        data: { channel: name },
      });
      const v = d.channels.view(cfg);
      d.emit({ type: 'channel.updated', channel: v });
      return v;
    },
    'channel.disconnect': async ({ name }, ctx) => {
      d.config.channels.require(name);
      const cfg = d.config.channels.update(name, (c) => ({ ...c, enabled: false }));
      await d.channels.disconnect(name);
      d.audit({
        type: 'channel.disconnect',
        severity: 'security',
        summary: `Channel ${name} disconnected`,
        actor: deps.principal(ctx),
        data: { channel: name },
      });
      const v = d.channels.view(cfg);
      d.emit({ type: 'channel.updated', channel: v });
      return v;
    },

    // ── path picker ──
    'fs.list': async ({ path }, ctx) => {
      assertOwner(ctx);
      return listDirs(path, d.opts.fsRoots ?? []);
    },

    // ── instruction files ──
    'agent.instructionsWrite': async ({ name, path, content }, ctx) => {
      assertOwner(ctx);
      const a = d.agent(name);
      const rw = a.mounts.filter((m) => m.mode === 'rw').map((m) => absPath(expandHome(m.path)));
      const anyMount = a.mounts.map((m) => absPath(expandHome(m.path)));
      if (path.includes('\0')) throw new BeamhopError('invalid_input', 'invalid path');
      const target =
        isAbsolute(path) || path.startsWith('~')
          ? absPath(path)
          : rw[0]
            ? absPath(join(rw[0], path))
            : undefined;
      if (!target) throw new BeamhopError('forbidden', 'the agent has no read-write mount');
      const mount = rw.find((m) => within(target, m));
      if (!mount) {
        if (anyMount.some((m) => within(target, m)))
          throw new BeamhopError(
            'forbidden',
            'that mount is read-only; make it read-write to edit instructions',
          );
        throw new BeamhopError(
          'forbidden',
          'instruction files can only be written inside the agent’s mounts',
        );
      }
      const rel = relative(mount, target).split(sep).join('/');
      const kind = INSTRUCTION_FILES.find((f) => f.file === rel);
      if (!kind)
        throw new BeamhopError(
          'forbidden',
          `only harness instruction files can be written (${INSTRUCTION_FILES.map((f) => f.file).join(', ')})`,
        );
      if (isDenied(target)) throw new BeamhopError('forbidden', 'that path is always denied');
      // Confinement: the real parent must be exactly <real mount>/<dir of rel> (no symlinked dirs).
      const realMount = await realpath(mount).catch(() => {
        throw new BeamhopError('not_found', 'the mount does not exist');
      });
      const relDir = dirname(rel) === '.' ? '' : dirname(rel);
      const wantDir = relDir ? join(realMount, ...relDir.split('/')) : realMount;
      if (relDir) {
        const st = await lstat(wantDir).catch(() => undefined);
        if (!st) await mkdir(wantDir, { mode: 0o755 });
        else if (!st.isDirectory())
          throw new BeamhopError('sandbox_violation', `${relDir} is not a directory`);
      }
      if ((await realpath(wantDir)) !== wantDir)
        throw new BeamhopError('sandbox_violation', 'the instruction file path goes through a symbolic link');
      const file = join(wantDir, basename(rel));
      const cur = await lstat(file).catch(() => undefined);
      if (cur && !cur.isFile())
        throw new BeamhopError('sandbox_violation', 'not a regular file (symbolic links are refused)');
      // Write a fresh temp file (O_EXCL | O_NOFOLLOW) next to it, then rename over the target.
      const tmp = join(wantDir, `.${basename(rel)}.beamhop-${process.pid}-${Date.now().toString(36)}`);
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
      const fh = await open(tmp, flags, cur ? cur.mode & 0o777 : 0o644);
      try {
        await fh.writeFile(content, 'utf8');
      } finally {
        await fh.close();
      }
      try {
        await rename(tmp, file);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
      const bytes = Buffer.byteLength(content, 'utf8');
      d.audit({
        type: 'agent.instructions',
        severity: 'security',
        summary: `Instruction file ${rel} of ${name} written (${bytes} bytes)`,
        actor: deps.principal(ctx),
        agent: name,
        data: { path: file, harness: kind.harness, bytes },
      });
      return { path: file, harness: kind.harness, bytes };
    },

    // ── alerts & updates ──
    'alerts.get': async () => d.alerts.rules(),
    'alerts.set': async (patch, ctx) => {
      const clean = defined(AlertRulesPatch.parse(patch));
      const next = { ...d.alerts.rules(), ...clean };
      if (next.budgetWarn > next.budgetAlert)
        throw new BeamhopError('invalid_input', 'the budget warning must not be above the budget alert');
      d.updateGlobal((c) => ({ ...c, alerts: { ...(c.alerts ?? {}), ...clean } }));
      d.audit({
        type: 'alerts.set',
        severity: 'info',
        summary: `Alert rules changed (${Object.keys(clean).join(', ') || 'nothing'})`,
        actor: deps.principal(ctx),
        data: clean,
      });
      return d.alerts.rules();
    },
    'updates.get': async () => updatesView(),
    'updates.set': async (p, ctx) => {
      const clean = defined(p);
      d.updateGlobal((c) => ({ ...c, updates: { ...c.updates, ...clean } }));
      d.audit({
        type: 'updates.set',
        severity: 'info',
        summary: `Update settings changed (${Object.keys(clean).join(', ') || 'nothing'})`,
        actor: deps.principal(ctx),
        data: clean,
      });
      return updatesView();
    },

    // ── quorum ──
    'approval.quorumGet': async () => quorumView(),
    'approval.quorumSet': async ({ quorum }, ctx) => {
      assertOwner(ctx);
      // A quorum above the number of people who can approve could never be reached. Agent grants can
      // add approvers, so the largest pool (any agent's, or the global one) is the limit.
      const pools = [undefined, ...d.config.agents.list()].map(
        (a) =>
          d.approvals.policy(a).quorumFor({ requestedBy: { principal: 'system:quorum', role: 'system' } })
            .pool,
      );
      const max = Math.max(...pools);
      if (quorum > max)
        throw new BeamhopError(
          'invalid_input',
          `quorum ${quorum} can never be reached: only ${max} ${max === 1 ? 'person can' : 'people can'} approve. Add approvers (a role with canApprove) first`,
        );
      d.updateGlobal((c) => ({ ...c, approvals: { ...c.approvals, quorum } }));
      d.audit({
        type: 'approval.quorum',
        severity: 'security',
        summary: `Approval quorum set to ${quorum}`,
        actor: deps.principal(ctx),
        data: { quorum },
      });
      return quorumView();
    },

    // ── roles ──
    'role.define': async ({ role }, ctx) => {
      assertOwner(ctx);
      const patch = parseRolePatch(role);
      if (patch.name === 'owner' || patch.name === 'agent')
        throw new BeamhopError('forbidden', 'the owner and agent roles cannot be changed');
      const roles = (d.global().roles as RoleOverride[]).filter((r) => r.name !== patch.name);
      const isBuiltin = (BUILTIN_ROLES as readonly string[]).includes(patch.name);
      // A built-in override merges into the existing override; a custom role is replaced.
      const prev = (d.global().roles as RoleOverride[]).find((r) => r.name === patch.name);
      const merged: RoleOverride = isBuiltin && prev ? { ...prev, ...patch } : patch;
      const def = effectiveRoleDef(patch.name, [...roles, merged]);
      const parsed = RoleDef.safeParse(def);
      if (!parsed.success) throw new BeamhopError('invalid_input', 'invalid role definition');
      // Config stores full role definitions (the override merged onto its base).
      d.updateGlobal((c) => ({
        ...c,
        roles: [...c.roles.filter((r) => r.name !== patch.name), parsed.data],
      }));
      d.audit({
        type: 'role.define',
        severity: 'security',
        summary: `Role ${patch.name} ${prev ? 'updated' : 'defined'}`,
        actor: deps.principal(ctx),
        data: { role: patch.name, fields: Object.keys(patch) },
      });
      return parsed.data;
    },
    'role.delete': async ({ name }, ctx) => {
      assertOwner(ctx);
      if (name === 'owner' || name === 'agent')
        throw new BeamhopError('forbidden', 'the owner and agent roles cannot be changed');
      const roles = d.global().roles as RoleOverride[];
      const has = roles.some((r) => r.name === name);
      const isBuiltin = (BUILTIN_ROLES as readonly string[]).includes(name);
      if (!has) {
        if (isBuiltin) throw new BeamhopError('invalid_input', 'built-in roles cannot be deleted');
        throw new BeamhopError('not_found', `no role ${name}`);
      }
      if (!isBuiltin) {
        const used = roleInUse(name);
        if (used) throw new BeamhopError('conflict', `role ${name} is still in use (${used})`);
      }
      d.updateGlobal((c) => ({ ...c, roles: c.roles.filter((r) => r.name !== name) }));
      d.audit({
        type: 'role.delete',
        severity: 'security',
        summary: isBuiltin ? `Role ${name} reset to its built-in definition` : `Role ${name} deleted`,
        actor: deps.principal(ctx),
        data: { role: name },
      });
      return OK;
    },

    // ── owners & people ──
    'owner.list': async () => {
      const g = d.global();
      return {
        owners: g.owners.map((principal) => {
          const person = personOf(g.people, principal);
          const linked = person
            ? (g.people[person] ?? []).filter((p) => normalizePrincipal(p) !== normalizePrincipal(principal))
            : [];
          return { principal, ...(person ? { person } : {}), linked };
        }),
      };
    },
    'principal.list': async () => ({ people: d.global().people }),
    'principal.unlink': async ({ person, principal }, ctx) => {
      const g = d.global();
      const n = normalizePrincipal(principal);
      const list = g.people[person];
      if (!list?.some((p) => normalizePrincipal(p) === n))
        throw new BeamhopError('not_found', `${principal} is not linked to ${person}`);
      d.updateGlobal((c) => {
        const rest = (c.people[person] ?? []).filter((p) => normalizePrincipal(p) !== n);
        const people = { ...c.people };
        if (rest.length) people[person] = rest;
        else delete people[person];
        return { ...c, people };
      });
      d.audit({
        type: 'principal.unlink',
        severity: 'security',
        summary: `Unlinked ${principal} from ${person}`,
        actor: deps.principal(ctx),
        data: { person, principal },
      });
      return OK;
    },
  };
  return { handlers: h, whoami, assertOwner };
};
