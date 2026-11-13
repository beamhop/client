import { resolve } from 'node:path';
import { createClient, directTransport, RpcError } from '@beamhop/client';
import { describe, expect, it } from 'vitest';
import { type Prompter, runInit } from '../src/init.ts';
import { buildProgram, type CliIO } from '../src/program.ts';

const OWNER = `npub1${'q'.repeat(58)}`;
const AGENT_NPUB = `npub1${'z'.repeat(58)}`;

type Handler = (params: Record<string, unknown>) => unknown;

/** A fake daemon: sensible answers for every method `init` uses; `over` replaces some. */
const fakeDaemon = (over: Record<string, Handler> = {}) => {
  const calls: [string, Record<string, unknown>][] = [];
  let pairPolls = 0;
  let helloPolls = 0;
  let owner: string | undefined;
  const base: Record<string, Handler> = {
    'system.status': () => ({ version: '0.1.0', home: '/home/x/.beamhop', owner: {} }),
    'system.doctor': () => ({
      checks: [
        { id: 'srt', title: 'srt runtime', status: 'ok', message: '1.0' },
        {
          id: 'bwrap',
          title: 'bubblewrap',
          status: 'fail',
          message: 'missing',
          fix: 'sudo apt install bubblewrap',
        },
      ],
    }),
    'harness.scan': () => ({
      harnesses: [
        { id: 'codex', displayName: 'Codex', command: 'codex', status: 'needs-login', protocol: 'acp' },
        { id: 'claude', displayName: 'Claude Code', command: 'claude', status: 'ready', protocol: 'acp' },
        {
          id: 'gemini',
          displayName: 'Gemini CLI',
          command: 'gemini',
          status: 'not-installed',
          protocol: 'acp',
          install: { npm: '@google/gemini-cli' },
        },
      ],
    }),
    'harness.list': () => ({ harnesses: [] }),
    'identity.get': () => ({ ...(owner ? { npub: owner } : {}), agents: [] }),
    'identity.ownerCreate': () => {
      owner = OWNER;
      return { npub: OWNER };
    },
    'identity.ownerImport': (p) => {
      owner = String(p.npub);
      return { npub: owner };
    },
    'identity.ownerExport': () => ({ nsec: ['nsec1', 'x'.repeat(58)].join('') }),
    'agent.presets': () => ({
      presets: [
        {
          id: 'personal-assistant',
          title: 'Personal assistant',
          description: 'DMs',
          config: { sandbox: { profile: 'workspace' } },
        },
        {
          id: 'code-reviewer',
          title: 'Code reviewer',
          description: 'ro',
          config: { sandbox: { profile: 'strict' } },
        },
      ],
    }),
    'agent.list': () => ({ agents: [] }),
    'agent.create': (p) => ({
      config: { ...(p.config as object), identity: { npub: AGENT_NPUB, nostrKeyRef: 'agent.x.nsec' } },
    }),
    'device.pairStart': () => ({
      uri: 'https://app.beamhop.dev/pair#eyJ2IjoxfQ',
      link: 'beamhop://pair#eyJ2IjoxfQ',
      code: 'ABC234',
      expiresAt: '2026-11-13T10:10:00Z',
      pairingId: 'pair_1',
    }),
    'device.pairStatus': () =>
      ++pairPolls < 3
        ? { pairingId: 'pair_1', status: 'waiting', expiresAt: 'x' }
        : {
            pairingId: 'pair_1',
            status: 'awaiting-confirm',
            expiresAt: 'x',
            safetyPhrase: ['amber', 'relay', 'otter', 'nine'],
          },
    'device.pairConfirm': (p) =>
      p.accept
        ? {
            pairingId: 'pair_1',
            status: 'paired',
            expiresAt: 'x',
            device: { id: 'dev_1', name: 'iPhone', pubkey: 'p', pairedAt: 'x', pushEnabled: false },
          }
        : { pairingId: 'pair_1', status: 'rejected', expiresAt: 'x' },
    'onboarding.hello': () => ({ to: owner, from: AGENT_NPUB, id: 'e1', sentAt: '2026-11-13T10:00:00Z' }),
    'onboarding.helloStatus': () =>
      ++helloPolls < 2
        ? { sent: true, replied: false, sentAt: '2026-11-13T10:00:00Z' }
        : {
            sent: true,
            replied: true,
            sentAt: '2026-11-13T10:00:00Z',
            repliedAt: '2026-11-13T10:00:04.200Z',
            text: 'hi',
          },
  };
  const handlers = { ...base, ...over };
  const client = createClient(
    directTransport(async (m, p) => {
      const params = (p ?? {}) as Record<string, unknown>;
      calls.push([m, params]);
      const h = handlers[m];
      if (!h) throw new RpcError(-32601, `unexpected call ${m}`);
      return h(params);
    }),
  );
  return { client, calls, methods: () => calls.map((c) => c[0]) };
};

const H = (fn: Handler): Handler => fn;

const cli = (daemon: ReturnType<typeof fakeDaemon>, interactive = false) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readStdin: async () => '',
    env: {},
    interactive,
  };
  const program = buildProgram({ io, client: async () => daemon.client, sleep: async () => {} });
  return { out, err, io, run: (...a: string[]) => program.parseAsync(['node', 'beamhop', ...a]) };
};

describe('beamhop init (headless)', () => {
  it('--yes: doctor, harnesses, new owner key, first agent; no pairing, no hello, no nsec export', async () => {
    const d = fakeDaemon();
    const t = cli(d);
    await t.run('init', '--yes');
    expect(t.err).toEqual([]);
    expect(t.io.exitCode).toBeUndefined();
    const m = d.methods();
    expect(m).toEqual([
      'system.status',
      'system.doctor',
      'harness.scan',
      'identity.get',
      'identity.ownerCreate',
      'agent.presets',
      'agent.list',
      'agent.create',
    ]);
    const create = d.calls.find((c) => c[0] === 'agent.create')![1];
    expect(create).toEqual({
      preset: 'personal-assistant',
      config: {
        name: 'assistant',
        harness: 'claude',
        mounts: [{ path: resolve(process.cwd()), mode: 'ro' }],
        sandbox: { profile: 'workspace' },
        memberships: [{ target: 'nostr:dm', defaultRole: 'viewer', triggers: ['dm', 'mention', 'reply'] }],
      },
    });
    const text = t.out.join('\n');
    expect(text).toContain('sudo apt install bubblewrap');
    expect(text).toContain('npm i -g @google/gemini-cli');
    expect(text).toContain(OWNER);
    expect(text).toContain(AGENT_NPUB);
    expect(text).toContain(`AI agent operated by ${OWNER}`);
    expect(text).toContain('Next steps');
    expect(text).not.toMatch(/nsec1/);
  });

  it('flags: import owner npub, pair a phone (QR + safety phrase), hello round trip', async () => {
    const d = fakeDaemon();
    const t = cli(d);
    await t.run(
      '--json',
      'init',
      '--yes',
      '--no-doctor',
      '--owner-npub',
      OWNER,
      '--pair',
      '--device-name',
      'iPhone',
      '--hello',
      '--agent-name',
      'rev',
      '--preset',
      'code-reviewer',
      '--mount',
      '/srv/repo',
      '--harness',
      'codex',
    );
    expect(t.err).toEqual([]);
    const m = d.methods();
    expect(m).not.toContain('system.doctor');
    expect(m).not.toContain('identity.ownerCreate');
    expect(d.calls.find((c) => c[0] === 'identity.ownerImport')![1]).toEqual({ npub: OWNER });
    expect(d.calls.find((c) => c[0] === 'device.pairStart')![1]).toEqual({
      name: 'iPhone',
      requireConfirm: true,
    });
    expect(m.filter((x) => x === 'device.pairStatus')).toHaveLength(3);
    expect(d.calls.find((c) => c[0] === 'device.pairConfirm')![1]).toEqual({
      pairingId: 'pair_1',
      accept: true,
    });
    const create = d.calls.find((c) => c[0] === 'agent.create')![1] as {
      preset: string;
      config: Record<string, unknown>;
    };
    expect(create.preset).toBe('code-reviewer');
    expect(create.config).toMatchObject({
      name: 'rev',
      harness: 'codex',
      mounts: [{ path: resolve('/srv/repo'), mode: 'ro' }],
      sandbox: { profile: 'strict' },
    });
    expect(d.calls.find((c) => c[0] === 'onboarding.hello')![1]).toEqual({ agent: 'rev' });
    const text = t.out.join('\n');
    expect(text).toContain('https://app.beamhop.dev/pair#eyJ2IjoxfQ');
    expect(text).toContain('beamhop://pair#eyJ2IjoxfQ');
    expect(text).toContain('AMBER · RELAY · OTTER · NINE');
    expect(text).toContain('Paired · iPhone');
    expect(text).toContain('It works');
    expect(text).toContain('4.2 s');
    // --json prints the machine-readable summary last
    expect(JSON.parse(t.out.at(-1)!.slice(t.out.at(-1)!.indexOf('{')))).toEqual({
      owner: OWNER,
      device: { id: 'dev_1', name: 'iPhone' },
      agent: { name: 'rev', npub: AGENT_NPUB },
      hello: 'replied',
    });
  });

  it('every step can be skipped; timeouts end the waits', async () => {
    const d = fakeDaemon({
      'device.pairStatus': H(() => ({ pairingId: 'pair_1', status: 'waiting', expiresAt: 'x' })),
      'onboarding.helloStatus': H(() => ({ sent: true, replied: false })),
    });
    let t0 = 0;
    const r = await runInit(
      {
        client: d.client,
        ui: (await import('../src/init.ts')).headlessPrompter(() => {}),
        sleep: async () => {
          t0 += 1000;
        },
        now: () => t0,
      },
      {
        pair: true,
        hello: true,
        doctor: false,
        harnesses: false,
        pairTimeout: 3,
        helloTimeout: 2,
        harness: 'x',
      },
    );
    expect(r.device).toBeUndefined();
    expect(r.hello).toBe('timeout');
    // An unanswered pairing is cancelled so its code cannot be used later.
    expect(d.calls.find((c) => c[0] === 'device.pairConfirm')![1]).toEqual({
      pairingId: 'pair_1',
      accept: false,
    });

    const d2 = fakeDaemon();
    const t = cli(d2);
    await t.run('init', '--yes', '--no-doctor', '--no-harnesses', '--no-identity', '--no-agent');
    expect(d2.methods()).toEqual(['system.status', 'identity.get']);
  });

  it('reuses an existing agent and exports the nsec only when asked', async () => {
    const d = fakeDaemon({
      'agent.list': H(() => ({
        agents: [{ config: { name: 'assistant', identity: { npub: AGENT_NPUB } } }],
      })),
    });
    const t = cli(d);
    await t.run('init', '--yes', '--no-doctor', '--export-nsec');
    expect(d.methods()).not.toContain('agent.create');
    expect(d.methods()).toContain('identity.ownerExport');
    expect(t.out.join('\n')).toContain('already exists');
    expect(t.out.join('\n')).toContain('Owner secret key (nsec)');
  });

  it('interactive: a "no" on the safety phrase cancels the pairing', async () => {
    const d = fakeDaemon();
    const answers: string[] = [];
    const ui: Prompter = {
      ...(await import('../src/init.ts')).headlessPrompter(() => {}),
      interactive: true,
      confirm: async (msg, initial) => {
        answers.push(msg);
        return msg.startsWith('Does your phone show') ? false : initial;
      },
    };
    const r = await runInit(
      { client: d.client, ui, sleep: async () => {} },
      { doctor: false, harnesses: false, identity: false, agent: false, pair: true },
    );
    expect(r.device).toBeUndefined();
    expect(d.calls.find((c) => c[0] === 'device.pairConfirm')![1]).toEqual({
      pairingId: 'pair_1',
      accept: false,
    });
    expect(answers.some((a) => a.includes('AMBER · RELAY · OTTER · NINE'))).toBe(true);
  });

  it('reports a daemon that is not running', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      readStdin: async () => '',
      env: {},
    };
    const program = buildProgram({
      io,
      client: async () => {
        throw new Error('fetch failed');
      },
    });
    await program.parseAsync(['node', 'beamhop', 'init', '--yes']);
    expect(io.exitCode).toBe(1);
    expect(err.join('\n')).toContain('daemon is not running');
  });
});

describe('review wave C PAIR-2: `device pair --no-wait` / `--json` never pair without confirmation', () => {
  it('starts the pairing with requireConfirm and confirms only with --accept', async () => {
    for (const args of [
      ['device', 'pair', '--no-wait'],
      ['--json', 'device', 'pair'],
    ]) {
      const d = fakeDaemon();
      await cli(d).run(...args);
      expect(d.calls.find((c) => c[0] === 'device.pairStart')![1]).toMatchObject({ requireConfirm: true });
    }
    const d = fakeDaemon();
    const t = cli(d);
    await t.run('device', 'confirm', 'pair_1');
    expect(d.methods()).not.toContain('device.pairConfirm');
    await t.run('device', 'confirm', 'pair_1', '--accept');
    expect(d.calls.find((c) => c[0] === 'device.pairConfirm')![1]).toEqual({
      pairingId: 'pair_1',
      accept: true,
    });
  });
});
