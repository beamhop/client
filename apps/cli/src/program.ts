import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { BeamhopClient } from '@beamhop/client';
import { RpcError } from '@beamhop/client';
import { Command, Option } from 'commander';
import pc from 'picocolors';
import {
  clackPrompter,
  headlessPrompter,
  InitCancelled,
  type InitOptions,
  type Prompter,
  pairPhone,
  runInit,
  terminalQr,
} from './init.ts';

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
  /** Read all of stdin (for secrets). */
  readStdin(): Promise<string>;
  env: Record<string, string | undefined>;
  /** True when stdin/stdout are a terminal (wizards prompt; otherwise they take defaults). */
  interactive?: boolean;
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
  /** Prompter for interactive wizards (default: @clack/prompts). */
  prompter?(): Promise<Prompter>;
  /** Injected wait for wizard polling (tests). */
  sleep?(ms: number): Promise<void>;
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

/** `~/code/app:rw` → { mount: '~/code/app', mountMode: 'rw' } (the suffix is optional). */
const splitMount = (m: string): { mount: string; mountMode?: 'ro' | 'rw' } => {
  const match = /^(.*?):(ro|rw)$/.exec(m);
  return match ? { mount: match[1]!, mountMode: match[2] as 'ro' | 'rw' } : { mount: m };
};

const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);

const STATUS_DOT: Record<string, string> = {
  ok: pc.green('✓'),
  warn: pc.yellow('!'),
  fail: pc.red('✗'),
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

  // ── first run ─────────────────────────────────────────────
  program
    .command('init')
    .description('first-run setup: doctor, harnesses, owner key, phone, first agent, hello')
    .option(
      '-y, --yes',
      'no questions: accept defaults (pairing and the hello test only with --pair / --hello)',
    )
    .option('--owner-npub <npub>', 'use your existing Nostr key; the daemon keeps only the npub')
    .option('--export-nsec', 'show the new owner nsec once (backup)')
    .option('--no-doctor', 'skip the doctor step')
    .option('--no-harnesses', 'skip harness discovery')
    .option('--no-identity', 'skip the owner identity step')
    .option('--pair', 'pair a phone (QR code)')
    .option('--no-pair', 'skip phone pairing')
    .option('--no-agent', 'skip creating the first agent')
    .option('--hello', 'send the hello DM and wait for your reply')
    .option('--no-hello', 'skip the hello round trip')
    .option('--agent-name <name>', 'first agent name')
    .option('--harness <id>', 'harness for the first agent')
    .option('--preset <id>', 'agent preset (personal-assistant, code-reviewer, team-dev-bot, public-qa)')
    .option('--mount <path[:ro|rw]>', 'folder the first agent may use (same form as `agent add --mount`)')
    .addOption(new Option('--mount-mode <mode>', 'folder access').choices(['ro', 'rw']))
    .addOption(
      new Option('--sandbox <profile>', 'sandbox profile for the first agent').choices([
        'strict',
        'workspace',
      ]),
    )
    // `agent add` calls it --profile; accept that spelling here too.
    .addOption(new Option('--profile <profile>').choices(['strict', 'workspace']).hideHelp())
    .option('--device-name <name>', 'name for the paired phone')
    .option('--pair-timeout <seconds>', 'how long to wait for the phone', Number)
    .option('--hello-timeout <seconds>', 'how long to wait for your reply', Number)
    .action(async (raw: Record<string, unknown>, cmd: Command) => {
      const src = (k: string) => cmd.getOptionValueSource(k);
      // `--no-x` flags default to true in commander; only explicit choices count as flags.
      const flag = (k: string): boolean | undefined => (src(k) === 'cli' ? (raw[k] as boolean) : undefined);
      const o: InitOptions = {
        yes: raw.yes === true,
        ...(raw.ownerNpub ? { ownerNpub: String(raw.ownerNpub) } : {}),
        ...(raw.exportNsec ? { exportNsec: true } : {}),
        ...Object.fromEntries(
          (['doctor', 'harnesses', 'identity', 'pair', 'agent', 'hello'] as const)
            .map((k) => [k, flag(k)] as const)
            .filter(([, v]) => v !== undefined),
        ),
        ...(raw.agentName ? { agentName: String(raw.agentName) } : {}),
        ...(raw.harness ? { harness: String(raw.harness) } : {}),
        ...(raw.preset ? { preset: String(raw.preset) } : {}),
        ...(raw.mount ? splitMount(String(raw.mount)) : {}),
        ...(raw.mountMode ? { mountMode: raw.mountMode as 'ro' | 'rw' } : {}),
        ...(raw.sandbox || raw.profile
          ? { sandbox: (raw.sandbox ?? raw.profile) as 'strict' | 'workspace' }
          : {}),
        ...(raw.deviceName ? { deviceName: String(raw.deviceName) } : {}),
        ...(raw.pairTimeout ? { pairTimeout: Number(raw.pairTimeout) } : {}),
        ...(raw.helloTimeout ? { helloTimeout: Number(raw.helloTimeout) } : {}),
      };
      try {
        const c = await deps.client();
        const interactive = !o.yes && io.interactive === true;
        const ui = interactive ? await (deps.prompter ?? clackPrompter)() : headlessPrompter(io.out);
        const res = await runInit({ client: c, ui, ...(deps.sleep ? { sleep: deps.sleep } : {}) }, o);
        if (json()) io.out(JSON.stringify(res, null, 2));
      } catch (e) {
        if (e instanceof InitCancelled) {
          io.exitCode = 130;
          return;
        }
        io.exitCode = 1;
        if (
          e instanceof Error &&
          /ECONNREFUSED|fetch failed|no API token/.test(
            `${e.message} ${(e as { cause?: Error }).cause?.message ?? ''}`,
          )
        )
          io.err(
            `${pc.red('error')} beamhop daemon is not running. Start it with ${pc.bold('beamhop daemon')}, then run ${pc.bold('beamhop init')}.`,
          );
        else io.err(`${pc.red('error')} ${(e as Error).message}`);
      }
    });

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
    .option('--reason <text>', 'why (recorded in the audit log)')
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
    .action(
      act(async (c) => {
        const s = await c.call('system.status');
        if (s?.panic === false)
          return {
            data: { ok: true, panic: false },
            human: () => 'nothing to resume: beamhop is not in panic mode.',
          };
        return { data: await c.call('system.resume'), human: () => pc.green('resumed.') };
      }),
    );

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
      try {
        await deps.runDaemon({ port: o.port });
      } catch (e) {
        io.exitCode = 1;
        const err = e as Error & { code?: string; port?: number };
        if (err.code === 'EADDRINUSE')
          io.err(
            `${pc.red('error')} port ${err.port ?? o.port ?? ''} is already in use. Is another beamhop daemon running? Pick a free port with ${pc.bold('BEAMHOP_PORT=<port>')} or ${pc.bold('--port <port>')}.`,
          );
        else if (/another beamhop daemon is running/.test(err.message))
          io.err(
            `${pc.red('error')} ${err.message}. Use that one (${pc.bold('beamhop status')}), stop it first, or set ${pc.bold('BEAMHOP_HOME')} to run a separate daemon.`,
          );
        else io.err(`${pc.red('error')} ${err.message}`);
      }
    });

  program
    .command('ui')
    .description('print the URL of the local web UI (contains your access token — do not share)')
    .action(async () => {
      if (!deps.uiUrl) return;
      try {
        io.out(await deps.uiUrl());
      } catch (e) {
        io.exitCode = 1;
        io.err(`${pc.red('error')} ${(e as Error).message}`);
      }
    });

  // ── agents ─────────────────────────────────────────────
  const agent = program.command('agent').description('manage agents');
  agent
    .command('ls')
    .alias('list')
    .description('list agents with status, sessions and spend today')
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
    .description("show an agent's full config, status and npub (JSON)")
    .action(act(async (c, name: string) => ({ data: await c.call('agent.get', { name }) })));
  agent
    .command('add <name>')
    .description('create an agent')
    .requiredOption('--harness <id>', 'harness id from `beamhop harness ls`')
    .option('--preset <id>', 'personal-assistant | code-reviewer | team-dev-bot | public-qa')
    .option('--mount <path[:ro|rw]>', 'mount a directory (repeatable)', collect)
    .option('--profile <profile>', 'sandbox profile: strict | workspace | custom')
    .option('--model <model>', 'model id (default: the harness default)')
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
          const warnings: string[] = [];
          for (const m of mounts)
            if (!existsSync(expandHome(m.path))) warnings.push(`mount ${m.path} does not exist (yet)`);
          const h = await c
            .call('harness.list')
            .then((r) => r?.harnesses?.find((x) => x.id === o.harness))
            .catch(() => null);
          if (h === undefined)
            warnings.push(`harness "${o.harness}" is not known; \`beamhop harness ls\` lists the ids`);
          else if (h && h.status !== 'ready')
            warnings.push(
              `${h.displayName} is ${{ 'needs-login': 'not logged in', 'not-installed': 'not installed' }[h.status as string] ?? h.status}${h.message ? ` (${h.message})` : ''}; sessions will fail until it is ready`,
            );
          return {
            data: a,
            human: () =>
              [
                `${pc.green('created')} ${a.config.name} (${a.config.harness}, sandbox ${a.config.sandbox.profile})`,
                ...warnings.map((w) => pc.yellow(`! ${w}`)),
                pc.dim(
                  `next: beamhop join ${a.config.name} <channel>:dm --role owner, or try it now: beamhop session start ${a.config.name} "hello"`,
                ),
              ].join('\n'),
          };
        },
      ),
    );
  agent
    .command('rm <name>')
    .description('delete an agent and its config')
    .action(
      act(async (c, name: string) => ({
        data: await c.call('agent.delete', { name }),
        human: () => `removed ${name}`,
      })),
    );
  agent
    .command('start <name>')
    .description('start (or re-enable) an agent')
    .action(
      act(async (c, name: string) => ({
        data: await c.call('agent.start', { name }),
        human: () => `${pc.green('started')} ${name}`,
      })),
    );
  agent
    .command('stop <name>')
    .description('stop an agent; running sessions finish unless --hard')
    .option('--hard', 'kill running sessions immediately')
    .action(
      act(async (c, name: string, o: { hard?: boolean }) => ({
        data: await c.call('agent.stop', { name, hard: !!o.hard }),
        human: () => `stopped ${name}`,
      })),
    );
  agent
    .command('clone <name> <newName>')
    .description('copy an agent under a new name (new Nostr key)')
    .action(
      act(async (c, name: string, newName: string) => ({
        data: await c.call('agent.clone', { name, newName }),
        human: () => `cloned ${name} → ${newName}`,
      })),
    );
  agent
    .command('presets')
    .description('list the built-in presets for `agent add --preset`')
    .action(
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
          // `budgets.dailyUsd=3` → { budgets: { dailyUsd: 3 } } (the daemon deep-merges the patch).
          const keys = k.split('.');
          if (keys.some((x) => !x || x === '__proto__' || x === 'constructor' || x === 'prototype'))
            throw new Error(`invalid key "${k}"`);
          let node = patch;
          for (const key of keys.slice(0, -1)) {
            if (!node[key] || typeof node[key] !== 'object') node[key] = {};
            node = node[key] as Record<string, unknown>;
          }
          node[keys[keys.length - 1]!] = val;
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
    .description('list known harnesses and their status (from the last scan)')
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
  channel
    .command('providers')
    .description('list channel providers you can add')
    .action(
      act(async (c) => {
        const { providers } = await c.call('channel.providers');
        return { data: providers, human: () => table(providers as Row[], ['provider', 'displayName']) };
      }),
    );
  channel
    .command('ls')
    .alias('list')
    .description('list channels and their connection status')
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
          if (!v.ok)
            throw new Error(
              `validation failed: ${v.message}${
                Object.keys(secrets).length
                  ? ''
                  : `\n  no token given: put it in an environment variable and pass --token-env, e.g. MY_TOKEN=... beamhop channel add ${provider} --name ${o.name} --token-env MY_TOKEN`
              }`,
            );
          const ch = await c.call('channel.add', { name: o.name, provider, values, secrets });
          return {
            data: ch,
            human: () =>
              `${pc.green('connected')} ${ch.config.name} as ${v.identity?.handle ?? v.identity?.name ?? '?'}${v.message ? `\n${v.message}` : ''}\nnext: ${pc.bold(`beamhop channel pair ${ch.config.name}`)} to link your account as owner`,
          };
        },
      ),
    );
  channel
    .command('rm <name>')
    .description('disconnect a channel and delete its secrets')
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
        const data = await c.call('membership.join', { agent: agentName, membership: membership as never });
        const channelName = target.split(':')[0] ?? '';
        const known = await c
          .call('channel.list')
          .then((r) => r?.channels?.map((ch) => ch.config.name))
          .catch(() => undefined);
        const missing = known && !known.includes(channelName);
        return {
          data,
          human: () =>
            [
              `${pc.green('joined')} ${agentName} → ${target} (default role ${o.role})`,
              ...(missing
                ? [
                    pc.yellow(
                      `! no channel named "${channelName}" yet — the agent will not hear anything there until you add it (\`beamhop channel add <provider> --name ${channelName}\`; \`beamhop channel ls\` lists yours).`,
                    ),
                  ]
                : []),
            ].join('\n'),
        };
      }),
    );
  program
    .command('leave <agent> <target>')
    .description('remove an agent from a channel target it joined')
    .action(
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
    .description('list sessions')
    .option('--agent <name>', 'only this agent')
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
  session
    .command('show <id>')
    .description("print a session's transcript")
    .action(
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
                if (e.kind === 'permission')
                  return pc.yellow(`  ? approval ${e.approvalId}: ${e.text ?? ''}`);
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
    .description('send another message to a running session')
    .action(
      act(async (c, id: string, text: string[]) => ({
        data: await c.call('session.send', { id, text: text.join(' ') }),
        human: () => 'sent',
      })),
    );
  session
    .command('stop <id>')
    .description('stop a session')
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
    .description('allow a pending approval (ids from `beamhop approvals`)')
    .option('--always', 'allow this tool for the rest of the session')
    .option(
      '--forever [rule]',
      'save a permanent rule (e.g. "bash:npm test", "*.npmjs.org", "~/code/app/"); without a value, the exact request',
    )
    .option('--grant-role <role>', 'for access requests: role to grant')
    .action(
      act(async (c, id: string, o: { always?: boolean; forever?: string | boolean; grantRole?: string }) => ({
        data: await c.call('approval.decide', {
          id,
          allow: true,
          always: o.forever !== undefined,
          ...(o.always ? { session: true } : {}),
          ...(typeof o.forever === 'string' ? { rule: o.forever } : {}),
          grantRole: o.grantRole,
        } as never),
        human: () => pc.green(`approved ${id}`),
      })),
    );
  program
    .command('deny <id>')
    .description('deny a pending approval')
    .action(
      act(async (c, id: string) => ({
        data: await c.call('approval.decide', { id, allow: false }),
        human: () => `denied ${id}`,
      })),
    );

  // ── roles / people / owners ─────────────────────────────────────────────
  const role = program.command('role').description('roles and grants');
  role
    .command('ls')
    .description('list roles and who has been granted which')
    .action(
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
    .description('grant a role to a principal, e.g. `beamhop role grant telegram:5551 user`')
    .option('--agent <name>', 'only for this agent')
    .action(
      act(async (c, principal: string, rl: string, o: { agent?: string }) => ({
        data: await c.call('role.grant', { principal, role: rl, agent: o.agent }),
        human: () => `granted ${rl} to ${principal}${o.agent ? ` on ${o.agent}` : ''}`,
      })),
    );
  role
    .command('revoke <principal>')
    .description("remove a principal's role grant")
    .option('--agent <name>', 'only for this agent')
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
    .description('add an owner (npub or provider:userId)')
    .action(
      act(async (c, principal: string) => ({
        data: await c.call('owner.add', { principal }),
        human: () => `${principal} is now an owner`,
      })),
    );
  owner
    .command('rm <principal>')
    .description('remove an owner')
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
    .description("show an agent's effective sandbox policy")
    .action(act(async (c, name: string) => ({ data: await c.call('policy.get', { name }) })));
  policy
    .command('set <agent> <profile>')
    .description('set the sandbox profile: strict | workspace | custom')
    .action(
      act(async (c, name: string, profile: string) => ({
        data: await c.call('policy.set', { name, profile }),
        human: () => `${name} → ${profile}`,
      })),
    );
  policy
    .command('suggestions')
    .description('list policy changes learned from sandbox violations')
    .option('--agent <name>', 'only this agent')
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
    .description('apply a policy suggestion')
    .action(
      act(async (c, id: string) => ({
        data: await c.call('policy.applySuggestion', { id, accept: true }),
        human: () => `accepted ${id}`,
      })),
    );
  policy
    .command('reject <id>')
    .description('dismiss a policy suggestion')
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
  secret
    .command('ls')
    .description('list secret names (never values)')
    .action(
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
    .description('store a secret; reads the value from stdin, or --from-env')
    .option('--from-env <var>', 'read the value from this environment variable')
    .action(
      act(async (c, name: string, o: { fromEnv?: string }) => {
        const value = o.fromEnv ? io.env[o.fromEnv] : (await io.readStdin()).replace(/\r?\n$/, '');
        if (!value) throw new Error('empty secret value');
        return { data: await c.call('secret.set', { name, value }), human: () => `stored ${name}` };
      }),
    );
  secret
    .command('rm <name>')
    .description('delete a secret')
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
    .description('list schedules')
    .option('--agent <name>', 'only this agent')
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
    .description('run a prompt on a cron, webhook, file change or Nostr event')
    .addOption(
      new Option('--kind <kind>', 'trigger kind')
        .choices(['cron', 'webhook', 'file-change', 'nostr-event'])
        .default('cron'),
    )
    .requiredOption('--spec <spec>', 'cron expression, webhook path, glob or nostr filter JSON')
    .requiredOption('--prompt <text>', 'what to send the agent')
    .option('--post-to <target>', 'channel target for the reply, e.g. mybot:group/-100123')
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
    .description('delete a schedule')
    .action(
      act(async (c, id: string) => ({
        data: await c.call('schedule.remove', { id }),
        human: () => `removed ${id}`,
      })),
    );
  schedule
    .command('run <id>')
    .description('run a schedule now')
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
  deploy
    .command('providers')
    .description('list cloud providers and whether their API token is set')
    .action(
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
      .requiredOption(
        '--provider <id>',
        'hetzner | digitalocean | fly | render | railway (see `deploy providers`)',
      )
      .requiredOption('--agent <name>', 'agent to run in the cloud')
      .option('--region <id>', 'provider region')
      .option('--size <id>', 'provider machine size')
      .addOption(
        new Option('--mode <mode>', 'move the agent, or run a new copy')
          .choices(['move', 'new'])
          .default('move'),
      );
  deployOpts(
    deploy.command('plan').description('show what a deploy would create and cost (changes nothing)'),
  ).action(
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
  deployOpts(deploy.command('apply').description('create the cloud resources and move the agent')).action(
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
  deploy
    .command('ls')
    .description('list deployments')
    .action(
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
    .description('tear down a deployment and its cloud resources')
    .action(
      act(async (c, id: string) => ({
        data: await c.call('deploy.destroy', { id }),
        human: () => `destroying ${id}`,
      })),
    );

  // ── alerts ─────────────────────────────────────────────
  const alerts = program
    .command('alerts')
    .description('alert thresholds (budget, security spikes, offline agents)');
  const alertsHuman = (r: Record<string, unknown>) =>
    table(
      Object.entries(r).map(([rule, value]) => ({ rule, value })),
      ['rule', 'value'],
    );
  alerts
    .command('show')
    .description('show the current alert rules')
    .action(
      act(async (c) => {
        const r = await c.call('alerts.get');
        return { data: r, human: () => alertsHuman(r) };
      }),
    );
  alerts
    .command('set')
    .description(
      'change alert rules, e.g. `beamhop alerts set --budget 80,100 --spike 5/10m --heartbeat 15m`',
    )
    .option('--budget <warn,alert>', 'warn and alert at these % of the daily budget')
    .option('--spike <events/minutes>', 'security spike: this many events within N minutes, e.g. 5/10m')
    .option('--heartbeat <minutes>', 'a cloud agent is offline after this long without a heartbeat, e.g. 15m')
    .option('--nostr-dm', 'also DM owners on their channels')
    .option('--no-nostr-dm', 'alerts only as push / in the app')
    .action(
      act(
        async (
          c,
          o: { budget?: string; spike?: string; heartbeat?: string; nostrDm?: boolean },
          cmd: Command,
        ) => {
          const num = (v: string | undefined, what: string) => {
            const n = Number.parseInt(String(v ?? '').replace(/m$/, ''), 10);
            if (!Number.isFinite(n)) throw new Error(`${what}: expected a number, got "${v ?? ''}"`);
            return n;
          };
          const patch: Record<string, unknown> = {};
          if (o.budget !== undefined) {
            const [warn, alert] = o.budget.split(',');
            patch.budgetWarn = num(warn, '--budget');
            if (alert !== undefined) patch.budgetAlert = num(alert, '--budget');
          }
          if (o.spike !== undefined) {
            const [events, minutes] = o.spike.split('/');
            patch.spikeEvents = num(events, '--spike');
            if (minutes !== undefined) patch.spikeMinutes = num(minutes, '--spike');
          }
          if (o.heartbeat !== undefined) patch.heartbeatMinutes = num(o.heartbeat, '--heartbeat');
          if (cmd.getOptionValueSource('nostrDm') === 'cli') patch.nostrDm = o.nostrDm;
          if (!Object.keys(patch).length)
            throw new Error('nothing to change: pass --budget, --spike, --heartbeat or --[no-]nostr-dm');
          const r = await c.call('alerts.set', patch);
          return { data: r, human: () => alertsHuman(r) };
        },
      ),
    );

  // ── audit / usage ─────────────────────────────────────────────
  program
    .command('audit')
    .description('every decision, violation and config change, newest first')
    .option('--agent <name>', 'only this agent')
    .addOption(new Option('--severity <s>', 'only this severity').choices(['info', 'warn', 'security']))
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
    .description('tokens and spend per agent')
    .option('--days <n>', 'how many days back', (v) => Number.parseInt(v, 10), 7)
    .option('--agent <name>', 'only this agent')
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
  device
    .command('ls')
    .description('list paired devices')
    .action(
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
    .description('pair a phone: QR code for the hosted app, then confirm the safety phrase here')
    .option('--name <name>', 'device name', 'New device')
    .option('--no-wait', 'print the QR / link and exit (confirm later with `beamhop device confirm`)')
    .option('--timeout <seconds>', 'how long to wait for the phone', Number, 120)
    .action(async (o: { name: string; wait: boolean; timeout: number }) => {
      try {
        const c = await deps.client();
        if (json() || !o.wait) {
          // Always with confirmation (review wave C PAIR-2): whoever sees the QR must not be able to
          // pair silently; the phone joins only after `beamhop device confirm <pairingId>`.
          const p = await c.call('device.pairStart', { name: o.name, requireConfirm: true });
          if (json()) io.out(JSON.stringify(p, null, 2));
          else
            io.out(
              `${await terminalQr(p.uri)}\nOpen on your phone:\n${pc.bold(p.uri)}${p.link ? `\n${pc.dim(p.link)}` : ''}\ncode ${pc.bold(p.code)} ${pc.dim(`(expires ${p.expiresAt})`)}\nthen compare the safety phrase: ${pc.bold(`beamhop device confirm ${p.pairingId ?? ''}`)}`,
            );
          return;
        }
        const ui =
          io.interactive === true ? await (deps.prompter ?? clackPrompter)() : headlessPrompter(io.out);
        const dev = await pairPhone(
          {
            client: c,
            ui,
            sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
            now: Date.now,
          },
          { name: o.name, timeoutS: o.timeout },
        );
        if (!dev) io.exitCode = 1;
      } catch (e) {
        io.exitCode = e instanceof InitCancelled ? 130 : 1;
        if (!(e instanceof InitCancelled)) io.err(`${pc.red('error')} ${(e as Error).message}`);
      }
    });
  device
    .command('confirm <pairingId>')
    .description(
      'show the safety phrase of a pending pairing; --accept if it matches the phone, else --reject',
    )
    .option('--accept', 'the phrase matches the one on the phone: pair it')
    .option('--reject', 'the phrase does not match: cancel the pairing')
    .action(
      act(async (c, pairingId: string, o: { accept?: boolean; reject?: boolean }) => {
        const st = await c.call('device.pairStatus', { pairingId });
        const phrase = st.safetyPhrase ? st.safetyPhrase.join(' · ').toUpperCase() : undefined;
        if (!o.accept && !o.reject)
          return {
            data: st,
            human: () =>
              `${phrase ? `safety phrase ${pc.bold(phrase)}\n` : ''}pairing ${st.status}${st.status === 'awaiting-confirm' ? `\ncompare it with the phone, then run again with --accept or --reject` : ''}`,
          };
        const r = await c.call('device.pairConfirm', { pairingId, accept: !!o.accept && !o.reject });
        return { data: r, human: () => `pairing ${r.status}` };
      }),
    );
  device
    .command('rm <id>')
    .description('unpair a device')
    .action(
      act(async (c, id: string) => ({
        data: await c.call('device.remove', { id }),
        human: () => `removed device ${id}`,
      })),
    );

  const identity = program.command('identity').description('Nostr identities and NIP-05');
  identity
    .command('show')
    .description('show the owner and agent Nostr identities (JSON)')
    .action(act(async (c) => ({ data: await c.call('identity.get') })));
  identity
    .command('nip05')
    .description('print the nostr.json to host for NIP-05 handles on your domain')
    .requiredOption('--domain <domain>', 'domain you will host /.well-known/nostr.json on')
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
    .description('export transcripts and audit data to a file')
    .option('--agent <name>', 'only this agent')
    .action(
      act(async (c, o: { agent?: string }) => {
        const r = await c.call('data.export', { agent: o.agent });
        return { data: r, human: () => `exported to ${r.path}` };
      }),
    );
  data
    .command('purge')
    .description('delete transcripts and audit data')
    .option('--agent <name>', 'only this agent')
    .option('--before <isoDate>', 'only records older than this date')
    .action(
      act(async (c, o: { agent?: string; before?: string }) => {
        const r = await c.call('data.purge', { agent: o.agent, before: o.before });
        return { data: r, human: () => `deleted ${r.deleted} records` };
      }),
    );

  return program;
};
