// Live E2E: DM on a fake channel → daemon → opencode over ACP inside the real srt sandbox → reply.
// Uses opencode's own default (free) model. Run: pnpm vitest run -c vitest.live.config.ts apps/daemon
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@beamhop/core';
import { createAcpHarness } from '@beamhop/harness-acp';
import { createSandbox } from '@beamhop/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureSrtTmp, type SandboxFactory } from '../src/index.ts';
import { makeEnv, ownerAlice, setupBot, type TestEnv, tmpHome, until } from './helpers.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const opencodeBinary = (): string | undefined => {
  try {
    const base = createRequire(join(repoRoot, 'packages', 'harness-acp', 'package.json'));
    const req = createRequire(base.resolve('opencode-ai/package.json'));
    const os = platform() === 'win32' ? 'windows' : platform();
    const exe = os === 'windows' ? 'opencode.exe' : 'opencode';
    for (const variant of ['', '-baseline']) {
      try {
        const bin = join(dirname(req.resolve(`opencode-${os}-${arch()}${variant}/package.json`)), 'bin', exe);
        if (existsSync(bin)) return bin;
      } catch {
        // next
      }
    }
  } catch {
    // not installed
  }
  return undefined;
};

const bin = opencodeBinary();
const hasBwrap =
  process.platform === 'linux' && spawnSync('which', ['bwrap'], { stdio: 'ignore' }).status === 0;

let env: TestEnv | undefined;
afterAll(() => env?.close());

describe.runIf(Boolean(bin) && hasBwrap)('opencode via the daemon (live)', () => {
  it('owner DM → sandboxed opencode → reply', async () => {
    const root = tmpHome();
    const work = join(root, 'work');
    const home = join(work, '.home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(work, 'opencode.json'), JSON.stringify({ autoupdate: false, share: 'disabled' }));
    const extraEnv: Record<string, string> = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
    for (const k of ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'])
      if (process.env[k]) extraEnv[k] = process.env[k]!;
    const proxy = process.env.HTTPS_PROXY;
    ensureSrtTmp();
    const sandbox: SandboxFactory = (policy, o) =>
      createSandbox(
        {
          ...policy,
          net: { ...policy.net, allow: [...policy.net.allow, 'opencode.ai', '*.opencode.ai', 'models.dev'] },
        },
        {
          // Only upper-case HTTPS_PROXY is set for opencode (lower+upper makes Bun hang); srt injects its own.
          env: { ...o.env, ...extraEnv },
          ...(o.brokerPort ? { brokerPort: o.brokerPort } : {}),
          localAllow: o.localAllow,
          log: o.log,
          ...(proxy ? { parentProxy: { https: proxy } } : {}),
        },
      );
    const logs: string[] = [];
    const harness = createAcpHarness({
      id: 'opencode',
      displayName: 'OpenCode',
      command: bin!,
      args: ['acp'],
      detect: async () => null,
      startTimeoutMs: 90_000,
      log: createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
    });
    // No broker: opencode talks to its own in-sandbox loopback server, which the broker NO_PROXY routing breaks.
    env = await makeEnv({ harness: harness as never, sandbox, llmProxy: false });
    // makeEnv registered `harness` as the fake harness plugin list; add the real one too.
    env.d.registry.addHarness(harness);
    const conn = await setupBot(env, {
      harness: 'opencode',
      model: 'default',
      mounts: [{ path: work, mode: 'rw', parallelUnsafe: true }],
    });
    await ownerAlice(env);
    conn.inject({ text: 'Reply with the single word pong and nothing else. Do not use tools.' });
    const dump = () => {
      const [s0] = env!.d.store.sessions.list();
      if (s0)
        console.log(
          '[events]',
          env!.d.store.sessions
            .events(s0.id)
            .map((e) => `${e.kind}:${(e.text ?? JSON.stringify(e.tool ?? '')).slice(0, 300)}`)
            .join('\n'),
        );
      console.log(
        '[audit]',
        env!.d.store.audit
          .query({ limit: 50 })
          .map((a) => a.summary)
          .join('\n'),
      );
      console.log('[logs]', logs.slice(-40).join('\n'));
      console.log('[sent]', conn.textsTo('alice').join('\n---\n'));
    };
    try {
      await until(() => conn.textsTo('alice').some((t) => /pong|⚠️/i.test(t)), 100_000, 'pong');
    } catch (e) {
      dump();
      throw e;
    }
    if (!conn.textsTo('alice').some((t) => /pong/i.test(t))) dump();
    const [s] = env.d.store.sessions.list();
    console.log(
      '[daemon opencode live]',
      env.d.store.sessions
        .events(s!.id)
        .map((e) => `${e.kind}:${(e.text ?? '').slice(0, 80)}`)
        .join(' | '),
    );
    expect(conn.textsTo('alice').join('\n').toLowerCase()).toContain('pong');
  }, 120_000);
});
