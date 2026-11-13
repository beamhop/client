import type { BeamhopClient } from '@beamhop/client';
import { RpcError } from '@beamhop/client';
import { Command, Option } from 'commander';
import pc from 'picocolors';

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
  /** Read all of stdin (for secrets). */
  readStdin(): Promise<string>;
  env: Record<string, string | undefined>;
  /** Set when a command fails, so main() can exit non-zero. */
  exitCode?: number;
}

export interface CliDeps {
  client(): Promise<BeamhopClient>;
  io: CliIO;
  /** Runs the daemon in the foreground (wired by main.ts). */
  runDaemon?(opts: { port?: number; open?: boolean }): Promise<void>;
  /** URL of the local API for `beamhop ui`. */
  uiUrl?(): Promise<string>;
}

type Row = Record<string, unknown>;

const fmt = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
};

/** Render rows as an aligned table (no deps, stable for tests). */
export const table = (rows: Row[], cols: string[]): string => {
  if (!rows.length) return pc.dim('(none)');
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => fmt(r[c]).length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    pc.bold(line(cols.map((c) => c.toUpperCase()))),
    ...rows.map((r) => line(cols.map((c) => fmt(r[c])))),
  ].join('\n');
};

const parseKv = (pairs: string[] = []): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) throw new Error(`expected key=value, got "${p}"`);
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
};

const collect = (v: string, prev: string[] = []) => [...prev, v];

const STATUS_DOT: Record<string, string> = {
  ok: pc.green('●'),
  warn: pc.yellow('●'),
  fail: pc.red('●'),
  skip: pc.dim('○'),
};

export const buildProgram = (deps: CliDeps): Command => {
  const { io } = deps;
  const program = new Command('beamhop')
    .description('Join your AI agent harnesses to Nostr, Telegram, Slack and Discord — sandboxed.')
    .version('0.1.0')
    .option('--json', 'machine-readable JSON output')
    .showHelpAfterError()
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) })
    .exitOverride();

  const json = () => Boolean(program.opts().json);

  /** Wrap an action: call the API, print JSON or a human rendering, map errors. */
  const act =
    <A extends unknown[]>(
      fn: (c: BeamhopClient, ...args: A) => Promise<{ data: unknown; human?: () => string }>,
    ) =>
    async (...args: A) => {
      try {
        const c = await deps.client();
        const { data, human } = await fn(c, ...args);
        if (json() || !human) io.out(JSON.stringify(data, null, 2));
        else io.out(human());
      } catch (e) {
        io.exitCode = 1;
        if (e instanceof RpcError) {
          if (json())
            io.err(JSON.stringify({ error: { code: e.beamhopCode ?? e.code, message: e.message } }));
          else io.err(`${pc.red('error')} ${e.message}`);
        } else if (
          e instanceof Error &&
          /ECONNREFUSED|fetch failed/.test(`${e.message} ${(e as { cause?: Error }).cause?.message ?? ''}`)
        ) {
          io.err(
            `${pc.red('error')} beamhop daemon is not running. Start it with ${pc.bold('beamhop daemon')}.`,
          );
        } else io.err(`${pc.red('error')} ${(e as Error).message}`);
      }
    };

  // ── system ─────────────────────────────────────────────
  program
    .command('status')
    .description('daemon, agents and approvals at a glance')
    .action(
      act(async (c) => {
        const s = await c.call('system.status');
        return {
          data: s,
          human: () =>
            [
              `${pc.bold('beamhop')} ${s.version}  ${s.panic ? pc.red('PANIC — everything stopped') : pc.green('running')}  up ${Math.round(s.uptimeSec)}s`,
              `agents ${s.agents}  channels ${s.channels}  pending approvals ${s.pendingApprovals > 0 ? pc.yellow(String(s.pendingApprovals)) : '0'}`,
              `owner ${s.owner.npub ?? pc.dim('not set — run beamhop init')}`,
              `home  ${s.home}`,
            ].join('\n'),
        };
      }),
    );

  program
    .command('doctor')
    .description('check sandbox prerequisites, harnesses and channels')
    .action(
      act(async (c) => {
        const r = await c.call('system.doctor');
        return {
          data: r,
          human: () =>
            r.checks
              .map(
                (k) =>
                  `${STATUS_DOT[k.status] ?? '?'} ${k.title}  ${pc.dim(k.message)}${k.fix ? `\n    ${pc.cyan('fix:')} ${k.fix}` : ''}`,
              )
              .join('\n'),
        };
      }),
    );

  program
    .command('panic')
    .description(
      'EMERGENCY STOP: kill all sessions, pause schedules, disconnect channels (incl. cloud agents)',
    )
    .option('--reason <text>')
    .action(
      act(async (c, o: { reason?: string }) => ({
        data: await c.call('system.panic', { reason: o.reason }),
        human: () =>
          `${pc.red('■ panic engaged.')} Everything is stopped. Run ${pc.bold('beamhop resume')} when safe.`,
      })),
    );

  program
    .command('resume')
    .description('resume after panic')
    .action(act(async (c) => ({ data: await c.call('system.resume'), human: () => pc.green('resumed.') })));

  program
    .command('daemon')
    .description('run the beamhop daemon in the foreground')
    .option('-p, --port <port>', 'API port', (v) => Number.parseInt(v, 10))
    .action(async (o: { port?: number }) => {
      if (!deps.runDaemon) {
        io.err('daemon is not available in this build');
        io.exitCode = 1;
        return;
      }
      await deps.runDaemon({ port: o.port });
    });

  program
    .command('ui')
    .description('print the URL of the local web UI (contains your access token — do not share)')
    .action(async () => {
      if (!deps.uiUrl) return;
      io.out(await deps.uiUrl());
    });

  // ── agents ─────────────────────────────────────────────
  const agent = program.command('agent').description('manage agents');
  agent
    .command('ls')
    .alias('list')
    .action(
      act(async (c) => {
        const { agents } = await c.call('agent.list');
        return {
          data: agents,
          human: () =>
            table(
              agents.map((a) => ({
                name: a.config.name,
                harness: a.config.harness,
                status: a.status,
                sessions: a.activeSessions,
                today: `$${a.usageToday.usd.toFixed(2)}`,
                where: a.location.kind === 'cloud' ? `cloud:${a.location.provider}` : 'local',
              })),
              ['name', 'harness', 'status', 'sessions', 'today', 'where'],
            ),
        };
      }),
    );
  agent
    .command('show <name>')
    .action(act(async (c, name: string) => ({ data: await c.call('agent.get', { name }) })));
  agent
    .command('add <name>')
    .description('create an agent')
    .requiredOption('--harness <id>', 'harness id from `beamhop harness ls`')
    .option('--preset <id>', 'personal-assistant | code-reviewer | team-dev-bot | public-qa')
    .option('--mount <path[:ro|rw]>', 'mount a directory (repeatable)', collect)
    .option('--profile <profile>', 'sandbox profile: strict | workspace | custom')
    .option('--model <model>')
    .option('--public', 'answer unknown senders (viewer role)')
    .action(
      act(
        async (
          c,
          name: string,
          o: {
            harness: string;
            preset?: string;
            mount?: string[];
            profile?: string;
            model?: string;
            public?: boolean;
          },
        ) => {
          const mounts = (o.mount ?? []).map((m) => {
            const match = /^(.*?)(?::(ro|rw))?$/.exec(m);
            return { path: match?.[1] ?? m, mode: (match?.[2] as 'ro' | 'rw' | undefined) ?? 'ro' };
          });
          const config: Record<string, unknown> = { name, harness: o.harness, mounts };
          if (o.profile) config.sandbox = { profile: o.profile };
          if (o.model) config.model = o.model;
          if (o.public) config.public = true;
          const a = await c.call('agent.create', { config, preset: o.preset });
          return {
            data: a,
            human: () =>
              `${pc.green('created')} ${a.config.name} (${a.config.harness}, sandbox ${a.config.sandbox.profile})`,
          };
        },
      ),
    );
  agent
    .command('rm <name>')
    .action(
      act(async (c, name: string) => ({
        data: await c.call('agent.delete', { name }),
        human: () => `removed ${name}`,
      })),
    );
  agent
    .command('start <name>')
    .action(
      act(async (c, name: string) => ({
        data: await c.call('agent.start', { name }),
        human: () => `${pc.green('started')} ${name}`,
      })),
    );
  agent
    .command('stop <name>')
    .option('--hard', 'kill running sessions immediately')
    .action(
      act(async (c, name: string, o: { hard?: boolean }) => ({
        data: await c.call('agent.stop', { name, hard: !!o.hard }),
        human: () => `stopped ${name}`,
      })),
    );
  agent
    .command('clone <name> <newName>')
    .action(
      act(async (c, name: string, newName: string) => ({
        data: await c.call('agent.clone', { name, newName }),
        human: () => `cloned ${name} → ${newName}`,
      })),
    );
  agent.command('presets').action(
    act(async (c) => {
      const { presets } = await c.call('agent.presets');
      return { data: presets, human: () => table(presets as Row[], ['id', 'title', 'description']) };
    }),
  );
  agent
    .command('set <name> <key=value...>')
    .description('patch agent config, e.g. `beamhop agent set bot model=gpt-5 budgets.dailyUsd=3`')
    .action(
      act(async (c, name: string, pairs: string[]) => {
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(parseKv(pairs))) {
          let val: unknown = v;
          try {
            val = JSON.parse(v);
          } catch {
            /* plain string */
          }
          patch[k] = val;
        }
        return { data: await c.call('agent.update', { name, patch }), human: () => `updated ${name}` };
      }),
    );

  // ── harnesses ─────────────────────────────────────────────
  const harness = program.command('harness').description('discover and manage agent harnesses');
  const harnessTable = (
    hs: { id: string; displayName: string; status: string; version?: string; protocol: string }[],
  ) =>
    table(
      hs.map((h) => ({
        id: h.id,
        name: h.displayName,
        status: h.status,
        version: h.version ?? '',
        protocol: h.protocol,
      })),
      ['id', 'name', 'status', 'version', 'protocol'],
    );
  harness
    .command('scan')
    .description('look for installed harnesses')
    .action(
      act(async (c) => {
        const { harnesses } = await c.call('harness.scan');
        return { data: harnesses, human: () => harnessTable(harnesses) };
      }),
    );
  harness
    .command('ls')
    .alias('list')
    .action(
      act(async (c) => {
        const { harnesses } = await c.call('harness.list');
        return { data: harnesses, human: () => harnessTable(harnesses) };
      }),
    );
  harness
    .command('add <id>')
    .description('register any ACP-speaking agent, e.g. `beamhop harness add myagent --acp "my-agent --acp"`')
    .requiredOption('--acp <command>', 'command line that starts the agent in ACP mode')
    .action(
      act(async (c, id: string, o: { acp: string }) => {
        const [command = '', ...args] = o.acp.split(/\s+/).filter(Boolean);
        const h = await c.call('harness.add', { id, command, args });
        return {
          data: h,
          human: () =>
            `${h.status === 'ready' ? pc.green('ready') : pc.yellow(h.status)} ${h.id} ${h.message ?? ''}`,
        };
      }),
    );

  // ── channels ─────────────────────────────────────────────
  const channel = program.command('channel').description('connect messaging channels');
  channel.command('providers').action(
    act(async (c) => {
      const { providers } = await c.call('channel.providers');
      return { data: providers, human: () => table(providers as Row[], ['provider', 'displayName']) };
    }),
  );
  channel
    .command('ls')
    .alias('list')
    .action(
      act(async (c) => {
        const { channels } = await c.call('channel.list');
        return {
          data: channels,
          human: () =>
            table(
              channels.map((ch) => ({
                name: ch.config.name,
                provider: ch.config.provider,
                status: ch.status,
                as: ch.self?.handle ?? ch.self?.displayName ?? '',
              })),
              ['name', 'provider', 'status', 'as'],
            ),
        };
      }),
    );
  channel
    .command('add <provider>')
    .description(
      'add a channel non-interactively, e.g. `beamhop channel add telegram --name mybot --token-env TG_TOKEN`',
    )
    .requiredOption('--name <name>', 'channel name')
    .option('--token-env <var>', 'read the main token from this environment variable')
    .option(
      '--secret <id=ENV_VAR>',
      'map a wizard secret field to an environment variable (repeatable)',
      collect,
    )
    .option('--set <key=value>', 'wizard field value (repeatable)', collect)
    .action(
      act(
        async (
          c,
          provider: string,
          o: { name: string; tokenEnv?: string; secret?: string[]; set?: string[] },
        ) => {
          const values: Record<string, unknown> = parseKv(o.set);
          for (const [k, v] of Object.entries(values))
            if (typeof v === 'string' && v.includes(',')) values[k] = v.split(',').map((s) => s.trim());
          const secrets: Record<string, string> = {};
          const fromEnv = (envVar: string) => {
            const v = io.env[envVar];
            if (!v) throw new Error(`environment variable ${envVar} is empty`);
            return v;
          };
          if (o.tokenEnv) secrets.token = fromEnv(o.tokenEnv);
          for (const [id, envVar] of Object.entries(parseKv(o.secret))) secrets[id] = fromEnv(envVar);
          const v = await c.call('channel.validate', { provider, values, secrets });
          if (!v.ok) throw new Error(`validation failed: ${v.message}`);
          const ch = await c.call('channel.add', { name: o.name, provider, values, secrets });
          return {
            data: ch,
            human: () =>
              `${pc.green('connected')} ${ch.config.name} as ${v.identity?.handle ?? v.identity?.name ?? '?'}\nnext: ${pc.bold(`beamhop channel pair ${ch.config.name}`)} to link your account as owner`,
          };
        },
      ),
    );
  channel
    .command('rm <name>')
    .action(
      act(async (c, name: string) => ({
        data: await c.call('channel.remove', { name }),
        human: () => `removed ${name}`,
      })),
    );
  channel
    .command('pair <name>')
    .description('get a one-time code; send /pair <code> to the bot to become owner')
    .action(
      act(async (c, name: string) => {
        const p = await c.call('channel.pair', { name });
        return {
          data: p,
          human: () => `${pc.bold(p.code)}  ${p.instructions}\n${pc.dim(`expires ${p.expiresAt}`)}`,
        };
      }),
    );

  program
    .command('join <agent> <target>')
    .description(
      'make an agent join a channel target, e.g. `beamhop join myagent mybot:group/-100123 --role viewer`',
    )
    .option('--role <role>', 'default role for members', 'viewer')
    .option('--trigger <trigger>', 'dm | mention | reply | command | all (repeatable)', collect)
    .action(
      act(async (c, agentName: string, target: string, o: { role: string; trigger?: string[] }) => {
        const membership = { target, defaultRole: o.role, ...(o.trigger ? { triggers: o.trigger } : {}) };
        return {
          data: await c.call('membership.join', { agent: agentName, membership: membership as never }),
          human: () => `${pc.green('joined')} ${agentName} → ${target} (default role ${o.role})`,
        };
      }),
    );
  program.command('leave <agent> <target>').action(
    act(async (c, agentName: string, target: string) => ({
      data: await c.call('membership.leave', { agent: agentName, target }),
      human: () => `${agentName} left ${target}`,
    })),
  );

  // ── sessions ─────────────────────────────────────────────
  const session = program.command('session').description('agent sessions');
  session
    .command('ls')
    .alias('list')
    .option('--agent <name>')
    .action(
      act(async (c, o: { agent?: string }) => {
        const { sessions } = await c.call('session.list', { agent: o.agent });
        return {
          data: sessions,
          human: () =>
            table(
              sessions.map((s) => ({
                id: s.id,
                agent: s.agent,
                status: s.status,
                title: s.title.slice(0, 40),
                last: s.lastActivityAt,
              })),
              ['id', 'agent', 'status', 'title', 'last'],
            ),
        };
      }),
    );
  session.command('show <id>').action(
    act(async (c, id: string) => {
      const { events } = await c.call('session.events', { id, afterSeq: 0 });
      return {
        data: events,
        human: () =>
          events
            .map((e) => {
              if (e.kind === 'user')
                return `${pc.cyan(`${e.from?.displayName ?? e.from?.principal ?? 'user'}:`)} ${e.text ?? ''}`;
              if (e.kind === 'assistant') return `${pc.magenta('agent:')} ${e.text ?? ''}`;
              if (e.kind === 'tool_call') return pc.dim(`  ↳ ${e.tool?.title ?? e.tool?.name}`);
              if (e.kind === 'permission') return pc.yellow(`  ? approval ${e.approvalId}: ${e.text ?? ''}`);
              return pc.dim(`  ${e.kind}: ${e.text ?? ''}`);
            })
            .join('\n'),
      };
    }),
  );
  session
    .command('start <agent> <text...>')
    .description('start a session from the CLI (as owner)')
    .action(
      act(async (c, agentName: string, text: string[]) => {
        const s = await c.call('session.start', { agent: agentName, text: text.join(' ') });
        return {
          data: s,
          human: () => `started ${s.id} — follow with ${pc.bold(`beamhop session show ${s.id}`)}`,
        };
      }),
    );
  session
    .command('send <id> <text...>')
    .action(
      act(async (c, id: string, text: string[]) => ({
        data: await c.call('session.send', { id, text: text.join(' ') }),
        human: () => 'sent',
      })),
    );
  session
    .command('stop <id>')
    .action(
      act(async (c, id: string) => ({
        data: await c.call('session.stop', { id }),
        human: () => `stopped ${id}`,
      })),
    );

  // ── approvals ─────────────────────────────────────────────
  program
    .command('approvals')
    .description('list pending approvals')
    .option('--all', 'include decided ones')
    .action(
      act(async (c, o: { all?: boolean }) => {
        const { approvals } = await c.call('approval.list', { status: o.all ? 'all' : 'pending' });
        return {
          data: approvals,
          human: () =>
            table(
              approvals.map((a) => ({
                id: a.id,
                agent: a.agent,
                risk: a.risk,
                title: a.title.slice(0, 50),
                by: a.requestedBy.displayName ?? a.requestedBy.principal,
                status: a.status,
              })),
              ['id', 'agent', 'risk', 'title', 'by', 'status'],
            ),
        };
      }),
    );
  program
    .command('approve <id>')
    .option('--always', 'allow this tool for the rest of the session')
    .option('--grant-role <role>', 'for access requests: role to grant')
    .action(
      act(async (c, id: string, o: { always?: boolean; grantRole?: string }) => ({
        data: await c.call('approval.decide', {
          id,
          allow: true,
          always: !!o.always,
          grantRole: o.grantRole,
        }),
        human: () => pc.green(`approved ${id}`),
      })),
    );
  program
    .command('deny <id>')
    .action(
      act(async (c, id: string) => ({
        data: await c.call('approval.decide', { id, allow: false }),
        human: () => `denied ${id}`,
      })),
    );

  // ── roles / people / owners ─────────────────────────────────────────────
  const role = program.command('role').description('roles and grants');
  role.command('ls').action(
    act(async (c) => {
      const r = await c.call('role.list');
      return {
        data: r,
        human: () =>
          `${table(
            r.roles.map((x) => ({
              name: x.name,
              mode: x.permissionMode,
              sandbox: x.sandboxProfile,
              approve: x.canApprove,
              description: x.description,
            })),
            ['name', 'mode', 'sandbox', 'approve', 'description'],
          )}\n\n${table(
            Object.entries(r.grants).map(([principal, rl]) => ({ principal, role: rl })),
            ['principal', 'role'],
          )}`,
      };
    }),
  );
  role
    .command('grant <principal> <role>')
    .option('--agent <name>', 'only for this agent')
    .action(
      act(async (c, principal: string, rl: string, o: { agent?: string }) => ({
        data: await c.call('role.grant', { principal, role: rl, agent: o.agent }),
        human: () => `granted ${rl} to ${principal}${o.agent ? ` on ${o.agent}` : ''}`,
      })),
    );
  role
    .command('revoke <principal>')
    .option('--agent <name>')
    .action(
      act(async (c, principal: string, o: { agent?: string }) => ({
        data: await c.call('role.revoke', { principal, agent: o.agent }),
        human: () => `revoked ${principal}`,
      })),
    );
  program
    .command('link <person> <principal>')
    .description('link a channel account to a person, e.g. `beamhop link alice telegram:5551`')
    .action(
      act(async (c, person: string, principal: string) => ({
        data: await c.call('principal.link', { person, principal }),
        human: () => `linked ${principal} → ${person}`,
      })),
    );
  const owner = program.command('owner').description('manage owners (multiple owners supported)');
  owner
    .command('add <principal>')
    .action(
      act(async (c, principal: string) => ({
        data: await c.call('owner.add', { principal }),
        human: () => `${principal} is now an owner`,
      })),
    );
  owner
    .command('rm <principal>')
    .action(
      act(async (c, principal: string) => ({
        data: await c.call('owner.remove', { principal }),
        human: () => `${principal} is no longer an owner`,
      })),
    );

  // ── policy ─────────────────────────────────────────────
  const policy = program.command('policy').description('sandbox policy');
  policy
    .command('show <agent>')
    .action(act(async (c, name: string) => ({ data: await c.call('policy.get', { name }) })));
  policy
    .command('set <agent> <profile>')
    .description('strict | workspace | custom')
    .action(
      act(async (c, name: string, profile: string) => ({
        data: await c.call('policy.set', { name, profile }),
        human: () => `${name} → ${profile}`,
      })),
    );
  policy
    .command('suggestions')
    .option('--agent <name>')
    .action(
      act(async (c, o: { agent?: string }) => {
        const { suggestions } = await c.call('policy.suggestions', { name: o.agent });
        return {
          data: suggestions,
          human: () => table(suggestions as Row[], ['id', 'agent', 'kind', 'value', 'count']),
        };
      }),
    );
  policy
    .command('accept <id>')
    .action(
      act(async (c, id: string) => ({
        data: await c.call('policy.applySuggestion', { id, accept: true }),
        human: () => `accepted ${id}`,
      })),
    );
  policy
    .command('reject <id>')
    .action(
      act(async (c, id: string) => ({
        data: await c.call('policy.applySuggestion', { id, accept: false }),
        human: () => `rejected ${id}`,
      })),
    );

  // ── secrets ─────────────────────────────────────────────
  const secret = program
    .command('secret')
    .description('secrets (stored in the OS keychain; values are never shown)');
  secret.command('ls').action(
    act(async (c) => {
      const r = await c.call('secret.list');
      return {
        data: r,
        human: () =>
          `${pc.dim(`backend: ${r.backend}`)}\n${table(r.secrets as Row[], ['name', 'updatedAt'])}`,
      };
    }),
  );
  secret
    .command('set <name>')
    .description('reads the value from stdin, or --from-env')
    .option('--from-env <var>')
    .action(
      act(async (c, name: string, o: { fromEnv?: string }) => {
        const value = o.fromEnv ? io.env[o.fromEnv] : (await io.readStdin()).replace(/\r?\n$/, '');
        if (!value) throw new Error('empty secret value');
        return { data: await c.call('secret.set', { name, value }), human: () => `stored ${name}` };
      }),
    );
  secret
    .command('rm <name>')
    .action(
      act(async (c, name: string) => ({
        data: await c.call('secret.delete', { name }),
        human: () => `deleted ${name}`,
      })),
    );

  // ── schedules ─────────────────────────────────────────────
  const schedule = program.command('schedule').description('scheduled and event-driven prompts');
  schedule
    .command('ls')
    .option('--agent <name>')
    .action(
      act(async (c, o: { agent?: string }) => {
        const { schedules } = await c.call('schedule.list', { agent: o.agent });
        return {
          data: schedules,
          human: () => table(schedules as Row[], ['id', 'agent', 'kind', 'spec', 'postTo', 'enabled']),
        };
      }),
    );
  schedule
    .command('add <agent>')
    .addOption(
      new Option('--kind <kind>').choices(['cron', 'webhook', 'file-change', 'nostr-event']).default('cron'),
    )
    .requiredOption('--spec <spec>', 'cron expression, webhook path, glob or nostr filter JSON')
    .requiredOption('--prompt <text>')
    .option('--post-to <target>')
    .option('--tz <timezone>', 'IANA timezone', 'UTC')
    .requiredOption('--owner <principal>', 'whose role and budget applies')
    .action(
      act(
        async (
          c,
          agentName: string,
          o: { kind: string; spec: string; prompt: string; postTo?: string; tz: string; owner: string },
        ) => {
          const s = await c.call('schedule.add', {
            agent: agentName,
            kind: o.kind as 'cron',
            spec: o.spec,
            prompt: o.prompt,
            postTo: o.postTo,
            timezone: o.tz,
            owner: o.owner,
          });
          return { data: s, human: () => `scheduled ${s.id}` };
        },
      ),
    );
  schedule
    .command('rm <id>')
    .action(
      act(async (c, id: string) => ({
        data: await c.call('schedule.remove', { id }),
        human: () => `removed ${id}`,
      })),
    );
  schedule
    .command('run <id>')
    .action(
      act(async (c, id: string) => ({
        data: await c.call('schedule.run', { id }),
        human: () => `triggered ${id}`,
      })),
    );

  // ── deploy ─────────────────────────────────────────────
  const deploy = program
    .command('deploy')
    .description('run agents in the cloud (Hetzner, DigitalOcean, Fly.io, Render, Railway)');
  deploy.command('providers').action(
    act(async (c) => {
      const { providers } = await c.call('deploy.providers');
      return {
        data: providers,
        human: () => table(providers as Row[], ['id', 'displayName', 'kind', 'configured']),
      };
    }),
  );
  const deployOpts = (cmd: Command) =>
    cmd
      .requiredOption('--provider <id>')
      .requiredOption('--agent <name>')
      .option('--region <id>')
      .option('--size <id>')
      .addOption(new Option('--mode <mode>').choices(['move', 'new']).default('move'));
  deployOpts(deploy.command('plan')).action(
    act(
      async (
        c,
        o: { provider: string; agent: string; region?: string; size?: string; mode: 'move' | 'new' },
      ) => {
        const p = await c.call('deploy.plan', o);
        return {
          data: p,
          human: () =>
            [
              ...p.actions.map(
                (a) =>
                  `${a.op === 'create' ? pc.green('+') : a.op === 'delete' ? pc.red('-') : pc.yellow('~')} ${a.resource}  ${pc.dim(a.detail)}`,
              ),
              '',
              `estimated ${pc.bold(`$${p.monthlyCostUsd.toFixed(2)}/month`)}`,
              ...p.warnings.map((w) => pc.yellow(`! ${w}`)),
            ].join('\n'),
        };
      },
    ),
  );
  deployOpts(deploy.command('apply')).action(
    act(
      async (
        c,
        o: { provider: string; agent: string; region?: string; size?: string; mode: 'move' | 'new' },
      ) => {
        const d = await c.call('deploy.apply', o);
        return {
          data: d,
          human: () => `${pc.green('deploying')} ${d.agent} on ${d.provider} (${d.id}) — ${d.status}`,
        };
      },
    ),
  );
  deploy.command('ls').action(
    act(async (c) => {
      const { deployments } = await c.call('deploy.list');
      return {
        data: deployments,
        human: () => table(deployments as Row[], ['id', 'agent', 'provider', 'status', 'region', 'size']),
      };
    }),
  );
  deploy
    .command('destroy <id>')
    .action(
      act(async (c, id: string) => ({
        data: await c.call('deploy.destroy', { id }),
        human: () => `destroying ${id}`,
      })),
    );

  // ── audit / usage ─────────────────────────────────────────────
  program
    .command('audit')
    .option('--agent <name>')
    .addOption(new Option('--severity <s>').choices(['info', 'warn', 'security']))
    .option('--limit <n>', 'max events', (v) => Number.parseInt(v, 10), 50)
    .action(
      act(async (c, o: { agent?: string; severity?: 'info' | 'warn' | 'security'; limit: number }) => {
        const { events } = await c.call('audit.query', {
          agent: o.agent,
          severity: o.severity,
          limit: o.limit,
        });
        return {
          data: events,
          human: () =>
            table(
              events.map((e) => ({
                at: e.at,
                sev: e.severity,
                agent: e.agent ?? '',
                type: e.type,
                summary: e.summary,
              })),
              ['at', 'sev', 'agent', 'type', 'summary'],
            ),
        };
      }),
    );
  program
    .command('usage')
    .option('--days <n>', 'days', (v) => Number.parseInt(v, 10), 7)
    .option('--agent <name>')
    .action(
      act(async (c, o: { days: number; agent?: string }) => {
        const { rows } = await c.call('usage.query', { days: o.days, agent: o.agent });
        return {
          data: rows,
          human: () =>
            table(
              rows.map((r) => ({
                day: r.day,
                agent: r.agent,
                tokens: r.inputTokens + r.outputTokens,
                usd: `$${r.usd.toFixed(3)}`,
                minutes: r.minutes.toFixed(1),
              })),
              ['day', 'agent', 'tokens', 'usd', 'minutes'],
            ),
        };
      }),
    );

  // ── devices / identity / data ─────────────────────────────────────────────
  const device = program.command('device').description('paired devices (phones, browsers)');
  device.command('ls').action(
    act(async (c) => {
      const { devices } = await c.call('device.list');
      return {
        data: devices,
        human: () => table(devices as Row[], ['id', 'name', 'pairedAt', 'lastSeenAt', 'pushEnabled']),
      };
    }),
  );
  device
    .command('pair')
    .option('--name <name>', 'device name', 'New device')
    .action(
      act(async (c, o: { name: string }) => {
        const p = await c.call('device.pairStart', { name: o.name });
        return {
          data: p,
          human: () =>
            `Open on your phone:\n${pc.bold(p.uri)}\ncode ${pc.bold(p.code)} ${pc.dim(`(expires ${p.expiresAt})`)}`,
        };
      }),
    );
  device
    .command('rm <id>')
    .action(
      act(async (c, id: string) => ({
        data: await c.call('device.remove', { id }),
        human: () => `removed device ${id}`,
      })),
    );

  const identity = program.command('identity').description('Nostr identities and NIP-05');
  identity.command('show').action(act(async (c) => ({ data: await c.call('identity.get') })));
  identity
    .command('nip05')
    .requiredOption('--domain <domain>')
    .action(
      act(async (c, o: { domain: string }) => {
        const r = await c.call('identity.nip05', { domain: o.domain });
        return {
          data: r,
          human: () =>
            `${pc.bold(`Host this at https://${o.domain}/.well-known/nostr.json`)}\n${r.json}\n\n${Object.entries(
              r.snippets,
            )
              .map(([k, v]) => `${pc.cyan(k)}\n${v}`)
              .join('\n\n')}`,
        };
      }),
    );

  const data = program.command('data').description('export or purge transcripts and audit data');
  data
    .command('export')
    .option('--agent <name>')
    .action(
      act(async (c, o: { agent?: string }) => {
        const r = await c.call('data.export', { agent: o.agent });
        return { data: r, human: () => `exported to ${r.path}` };
      }),
    );
  data
    .command('purge')
    .option('--agent <name>')
    .option('--before <isoDate>')
    .action(
      act(async (c, o: { agent?: string; before?: string }) => {
        const r = await c.call('data.purge', { agent: o.agent, before: o.before });
        return { data: r, human: () => `deleted ${r.deleted} records` };
      }),
    );

  return program;
};
