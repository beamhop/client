// Live E2E: DM on a fake channel → daemon → opencode over ACP inside the real srt sandbox → reply.
// Uses opencode's own default (free) model. Run: pnpm vitest run -c vitest.live.config.ts apps/daemon
import { spawnSync } from 'node:child_process';
import { createLogger } from '@beamhop/core';
import { createAcpHarness } from '@beamhop/harness-acp';
import { afterAll, describe, expect, it } from 'vitest';
import { makeEnv, ownerAlice, setupBot, type TestEnv, tmpHome, until } from './helpers.ts';
import { opencodeBinary, opencodeWorkspace } from './live-helpers.ts';

const bin = opencodeBinary();
const hasBwrap =
  process.platform === 'linux' && spawnSync('which', ['bwrap'], { stdio: 'ignore' }).status === 0;

let env: TestEnv | undefined;
afterAll(() => env?.close());

describe.runIf(Boolean(bin) && hasBwrap)('opencode via the daemon (live)', () => {
  it('owner DM → sandboxed opencode → reply', async () => {
    const { work, sandbox } = opencodeWorkspace(tmpHome());
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
    // Broker on: opencode also talks to its own in-sandbox loopback server, which must keep working
    // while the broker / MCP bridge are reached through the in-sandbox forwarders.
    env = await makeEnv({ harness: harness as never, sandbox, llmProxy: true });
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
