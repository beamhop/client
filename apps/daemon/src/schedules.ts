/**
 * Schedules (§6A.4): cron (with timezone), webhook (`POST /hooks/<id>` with a per-schedule secret),
 * file-change (fs.watch on a mount glob) and nostr-event (when the mesh provider can subscribe).
 * Each run prompts the agent as the schedule owner and posts to `postTo` (only where the agent is a member).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, relative, sep } from 'node:path';
import { resolveRole } from '@beamhop/authz';
import {
  type AgentConfig,
  BeamhopError,
  expandHome,
  type Membership,
  parseTarget,
  type RoleDef,
  type ScheduleConfig,
} from '@beamhop/core';
import { nextCronTime, parseCron } from './cron.ts';
import type { Daemon } from './daemon.ts';
import { matchMembership } from './router.ts';
import { errMsg, pathGlobToRegExp } from './util.ts';

export const webhookSecretName = (id: string) => `schedule.${id}.secret`;
const MAX_PAYLOAD = 64 * 1024;
type RunResult = { ok: boolean; text: string; error?: string };

interface Armed {
  next?: number;
  watcher?: FSWatcher;
  unsubscribe?: () => void;
  debounce?: NodeJS.Timeout;
  changed?: Set<string>;
}

export class Scheduler {
  private readonly armed = new Map<string, Armed>();
  private running = false;

  constructor(private readonly d: Daemon) {}

  start(): void {
    this.stop();
    this.running = true;
    for (const s of this.d.config.schedules.list()) this.arm(s);
  }

  stop(): void {
    this.running = false;
    for (const id of [...this.armed.keys()]) this.disarm(id);
  }

  /** Panic: stop all triggers (persisted state is the global panic flag). */
  pauseAll(): void {
    this.stop();
  }

  rearm(id: string): void {
    this.disarm(id);
    const s = this.d.config.schedules.get(id);
    if (s && this.running) this.arm(s);
  }

  disarm(id: string): void {
    const a = this.armed.get(id);
    if (!a) return;
    a.watcher?.close();
    a.unsubscribe?.();
    if (a.debounce) clearTimeout(a.debounce);
    this.armed.delete(id);
  }

  nextRun(id: string): number | undefined {
    return this.armed.get(id)?.next;
  }

  private arm(s: ScheduleConfig): void {
    if (!s.enabled || s.paused) return;
    const a: Armed = {};
    try {
      switch (s.kind) {
        case 'cron':
          a.next = nextCronTime(parseCron(s.spec), this.d.now(), s.timezone);
          break;
        case 'file-change':
          this.watchFiles(s, a);
          break;
        case 'nostr-event': {
          const sub = this.d.mesh?.subscribe;
          if (!sub) {
            this.d.log.warn('nostr-event schedule needs the nostr channel', { id: s.id });
            break;
          }
          let filter: unknown;
          try {
            filter = JSON.parse(s.spec);
          } catch {
            throw new BeamhopError('invalid_input', 'nostr-event spec must be a JSON filter');
          }
          a.unsubscribe = sub.call(
            this.d.mesh,
            filter,
            (ev) =>
              void this.run(
                s.id,
                `Nostr event matched:\n\`\`\`json\n${JSON.stringify(ev).slice(0, 4000)}\n\`\`\``,
              ).catch(() => {}),
          );
          break;
        }
        case 'webhook':
          break;
      }
    } catch (e) {
      this.d.log.warn('schedule not armed', { id: s.id, error: errMsg(e) });
      return;
    }
    this.armed.set(s.id, a);
  }

  /** Validate a spec before saving. */
  validate(s: Pick<ScheduleConfig, 'kind' | 'spec' | 'timezone' | 'agent'>): void {
    if (s.kind === 'cron') {
      parseCron(s.spec);
      nextCronTime(s.spec, this.d.now(), s.timezone);
    } else if (s.kind === 'nostr-event') {
      try {
        JSON.parse(s.spec);
      } catch {
        throw new BeamhopError('invalid_input', 'nostr-event spec must be a JSON filter');
      }
    } else if (s.kind === 'file-change') this.resolveGlob(s.agent, s.spec);
  }

  /** A file-change glob resolves inside one of the agent's mounts. */
  private resolveGlob(agentName: string, spec: string): { root: string; re: RegExp } {
    const agent = this.d.agent(agentName);
    const mounts = agent.mounts.map((m) => expandHome(m.path));
    if (!mounts.length) throw new BeamhopError('invalid_input', 'file-change schedules need an agent mount');
    const raw = spec.startsWith('~') || isAbsolute(spec) ? expandHome(spec) : join(mounts[0]!, spec);
    const root = mounts.find((m) => {
      const r = relative(m, raw);
      return !r.startsWith('..') && !isAbsolute(r);
    });
    if (!root) throw new BeamhopError('invalid_input', 'file-change glob must be inside an agent mount');
    return { root, re: pathGlobToRegExp(relative(root, raw)) };
  }

  private watchFiles(s: ScheduleConfig, a: Armed): void {
    const { root, re } = this.resolveGlob(s.agent, s.spec);
    a.changed = new Set();
    a.watcher = watch(root, { recursive: true, persistent: false }, (_ev, file) => {
      if (!file) return;
      const rel = String(file).split(sep).join('/');
      if (!re.test(rel)) return;
      a.changed?.add(rel);
      if (a.debounce) clearTimeout(a.debounce);
      a.debounce = setTimeout(() => {
        const files = [...(a.changed ?? [])].slice(0, 50);
        a.changed?.clear();
        void this.run(s.id, `Files changed:\n${files.map((f) => `- ${f}`).join('\n')}`).catch(() => {});
      }, 1500);
    });
    a.watcher.on('error', (e) => this.d.log.warn('file watcher error', { id: s.id, error: errMsg(e) }));
  }

  async tick(): Promise<void> {
    if (!this.running || this.d.isPanic()) return;
    const now = this.d.now();
    for (const [id, a] of this.armed) {
      if (a.next === undefined || a.next > now) continue;
      const s = this.d.config.schedules.get(id);
      if (!s) {
        this.disarm(id);
        continue;
      }
      a.next = nextCronTime(parseCron(s.spec), now, s.timezone);
      void this.run(id).catch((e) => this.d.log.warn('schedule run failed', { id, error: errMsg(e) }));
    }
  }

  /** Run a schedule now. `extra` (webhook body etc.) is appended as untrusted input. */
  async run(id: string, extra?: string): Promise<RunResult> {
    const r = await this.prepare(id, extra)();
    if (!r.ok) this.d.log.warn('schedule run failed', { id, error: r.error ?? 'unknown error' });
    return r;
  }

  /**
   * Check that a schedule can run (agent exists and runs, owner has a role, may post where it posts)
   * and return the run itself. Throws on any of those, so `schedule.run` can report them to the caller
   * instead of answering ok and failing in the background.
   */
  prepare(id: string, extra?: string): () => Promise<RunResult> {
    const d = this.d;
    d.assertNotPanic();
    const s = d.config.schedules.require(id);
    const agent = d.agent(s.agent);
    if (d.isAgentStopped(agent.name)) throw new BeamhopError('unavailable', `agent ${agent.name} is stopped`);
    const roleName = resolveRole({ principal: s.owner, agent, global: d.authzGlobal() });
    if (!roleName)
      throw new BeamhopError('forbidden', `schedule owner ${s.owner} has no role on ${agent.name}`);
    const role = d.roleDef(roleName);
    let channel = 'schedule';
    let conversation: { kind: 'dm' | 'group' | 'channel' | 'public'; id: string } = { kind: 'dm', id: id };
    let membership: Membership | undefined;
    if (s.postTo) {
      const t = parseTarget(s.postTo);
      if (!t.id) throw new BeamhopError('invalid_input', 'postTo needs a conversation id');
      const kind = (t.kind === 'thread' ? 'group' : t.kind) as typeof conversation.kind;
      const m = matchMembership(agent, t.channel, kind, t.id);
      if (!m || m.membership.revokedAt) {
        d.audit({
          type: 'route.denied',
          severity: 'security',
          summary: `Schedule ${id} may not post to ${s.postTo}: ${agent.name} is not a member there`,
          actor: `schedule:${id}`,
          agent: agent.name,
        });
        throw new BeamhopError('forbidden', `${agent.name} is not a member of ${s.postTo}`);
      }
      membership = m.membership;
      channel = d.channels.connName(t.channel, agent.name);
      conversation = { kind, id: t.id };
    }
    const prompt = `${s.prompt}${extra ? `\n\n[beamhop] trigger payload below is untrusted input\n${extra.slice(0, MAX_PAYLOAD)}` : ''}`;
    return () => this.submit(id, s, agent, role, { channel, conversation, membership, prompt });
  }

  private submit(
    id: string,
    s: ScheduleConfig,
    agent: AgentConfig,
    role: RoleDef,
    o: {
      channel: string;
      conversation: { kind: 'dm' | 'group' | 'channel' | 'public'; id: string };
      membership: Membership | undefined;
      prompt: string;
    },
  ): Promise<RunResult> {
    const d = this.d;
    const { channel, conversation, membership, prompt } = o;
    d.audit({
      type: 'schedule.run',
      severity: 'info',
      summary: `Schedule ${id} (${s.kind}) ran for ${agent.name}`,
      actor: `schedule:${id}`,
      agent: agent.name,
    });
    return new Promise((resolveDone) => {
      void d.sessions.submit({
        agent,
        channel,
        conversation,
        threadId: `schedule-${id}`,
        ...(membership ? { membership } : {}),
        title: `schedule ${id}`,
        turn: {
          text: prompt,
          promptFor: () =>
            `[beamhop] schedule=${id} kind=${s.kind} owner=${s.owner} (role=${role.name}) time=${new Date(d.now()).toISOString()}\n\n${prompt}`,
          from: { principal: s.owner, role: role.name },
          role,
          attachments: [],
          hops: 0,
          source: 'schedule',
          done: resolveDone,
        },
      });
    });
  }

  // ───────────────────────────── webhooks ─────────────────────────────

  async createWebhookSecret(id: string): Promise<string> {
    const secret = randomBytes(24).toString('base64url');
    await this.d.secrets.set(webhookSecretName(id), secret);
    this.d.invalidateSecretCache();
    return secret;
  }

  /** `POST /hooks/<id>`: `x-beamhop-secret: <secret>` or `x-beamhop-signature: sha256=<hmac(body)>`. */
  async handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const m = /^\/hooks\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(url.pathname);
    if (!m) return false;
    const send = (status: number, body: unknown) =>
      res
        .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify(body));
    if (req.method !== 'POST') {
      send(405, { error: 'use POST' });
      return true;
    }
    const id = m[1]!;
    const s = this.d.config.schedules.get(id);
    const secret = s?.kind === 'webhook' ? await this.d.secrets.get(webhookSecretName(id)) : undefined;
    let body: string;
    try {
      body = await readLimited(req, MAX_PAYLOAD);
    } catch {
      send(413, { error: 'payload too large' });
      return true;
    }
    const presented = String(req.headers['x-beamhop-secret'] ?? '');
    const sig = String(req.headers['x-beamhop-signature'] ?? '');
    const expectSig = secret ? `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` : '';
    const ok = !!secret && (eq(presented, secret) || (sig !== '' && eq(sig, expectSig)));
    if (!s || !ok) {
      this.d.audit({
        type: 'webhook.rejected',
        severity: 'security',
        summary: `Rejected webhook call for ${id}${s ? ' (bad secret)' : ' (unknown hook)'}`,
        actor: `webhook:${req.socket.remoteAddress ?? 'unknown'}`,
        ...(s ? { agent: s.agent } : {}),
      });
      send(s ? 401 : 404, { error: s ? 'unauthorized' : 'not found' });
      return true;
    }
    if (!s.enabled || s.paused || this.d.isPanic()) {
      send(409, { error: 'schedule is paused' });
      return true;
    }
    void this.run(id, body).catch((e) => this.d.log.warn('webhook run failed', { id, error: errMsg(e) }));
    send(202, { ok: true });
    return true;
  }
}

const eq = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

const readLimited = (req: IncomingMessage, max: number): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
