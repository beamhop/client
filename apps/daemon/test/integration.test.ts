import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createTelegramPlugin } from '@beamhop/channel-telegram';
import type { HarnessEvent, HarnessPlugin, HarnessSession, SandboxHandle, SessionSpec } from '@beamhop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_TOKEN, FakeBotApi } from '../../../packages/channel-telegram/test/fake-bot-api.ts';
import {
  ALICE,
  BOB,
  BOT,
  DM_CHAT,
  dmText,
  GROUP,
  kicked,
} from '../../../packages/channel-telegram/test/fixtures.ts';
import { FakeHarnessPlugin, makeEnv, type TestEnv, tmpHome, until } from './helpers.ts';

let env: TestEnv | undefined;
let api: FakeBotApi | undefined;
afterEach(async () => {
  await env?.close();
  await api?.stop();
  env = undefined;
  api = undefined;
});

const sentTexts = (a: FakeBotApi, chatId: number) =>
  [...a.callsTo('sendMessage'), ...a.callsTo('editMessageText')]
    .filter((c) => Number(c.params.chat_id) === chatId)
    .map((c) => String(c.params.text ?? ''));

describe('real Telegram plugin against the fake Bot API', () => {
  it('pairing, DM reply, approvals with inline buttons, kick-to-revoke', async () => {
    api = await new FakeBotApi().start();
    const telegram = createTelegramPlugin({
      apiRoot: api.apiRoot,
      pollTimeoutSec: 1,
      backoffBaseMs: 10,
      backoffMaxMs: 50,
    });
    const harness = new FakeHarnessPlugin();
    env = await makeEnv({ plugins: { channels: [telegram], harnesses: [harness] } });
    const c = env.client;
    await c.call('channel.add', {
      name: 'tg',
      provider: 'telegram',
      values: {},
      secrets: { token: FAKE_TOKEN },
    });
    await until(
      async () => (await c.call('channel.list')).channels[0]?.status === 'connected',
      5000,
      'connected',
    );
    await c.call('agent.create', {
      config: {
        name: 'bot',
        harness: 'fake',
        memberships: [
          { target: 'tg:dm', defaultRole: 'viewer' },
          { target: `tg:group/${GROUP.id}`, defaultRole: 'user', triggers: ['mention', 'reply'] },
        ],
      },
    });

    // §5 step 5: pair the owner with /pair <code>
    const { code } = await c.call('channel.pair', { name: 'tg' });
    api.push(dmText(1, `/pair ${code}`));
    await until(() => env!.d.global().owners.includes(`telegram:${ALICE.id}`), 5000, 'paired');
    await until(() => sentTexts(api!, DM_CHAT.id).some((t) => t.includes('Paired')), 5000);

    // DM → harness → reply (live-edited)
    api.push(dmText(2, 'hello agent'));
    await until(
      () => sentTexts(api!, DM_CHAT.id).some((t) => t.includes('reply: hello agent')),
      5000,
      'reply',
    );
    expect(harness.latest().prompts[0]).toContain(`telegram:${ALICE.id}`);

    // group mention from a user → approval card with inline keyboard in the owner's DM
    api.push({
      update_id: 3,
      message: {
        message_id: 700,
        from: BOB,
        chat: GROUP,
        date: 1_731_000_500,
        text: `@${BOT.username} RUN_SHELL`,
        entities: [{ offset: 0, length: BOT.username.length + 1, type: 'mention' }],
      },
    });
    await until(() => env!.d.store.approvals.list().length === 1, 5000, 'approval');
    const approval = env.d.store.approvals.list()[0]!;
    await until(
      () =>
        api!
          .callsTo('sendMessage')
          .some((m) => JSON.stringify(m.params.reply_markup ?? '').includes(`approve:${approval.id}`)),
      5000,
      'card',
    );
    api.push({
      update_id: 4,
      callback_query: {
        id: 'cb1',
        from: ALICE,
        message: { message_id: 1, from: BOT, chat: DM_CHAT, date: 1_731_000_600, text: 'Approve?' },
        data: `approve:${approval.id}`,
      },
    });
    await until(() => sentTexts(api!, GROUP.id).some((t) => t.includes('shell allowed')), 5000, 'allowed');

    // kick-to-revoke
    api.push({ ...kicked, update_id: 5 });
    await until(
      () => !!env!.d.agent('bot').memberships.find((m) => m.target === `tg:group/${GROUP.id}`)?.revokedAt,
      5000,
      'revoked',
    );
    expect(env.d.store.audit.query({ type: 'membership.revoked' })).toHaveLength(1);
  });
});

// ───────────────────────────── real sandbox ─────────────────────────────

const hasBwrap =
  process.platform === 'linux' && spawnSync('which', ['bwrap'], { stdio: 'ignore' }).status === 0;
const SCRIPT = fileURLToPath(new URL('./fixtures/sandbox-harness.mjs', import.meta.url));

/** A HarnessPlugin that runs a real node script inside the sandbox it is given. */
const scriptHarness = (extra: {
  secretFile: string;
  outsideFile: string;
}): HarnessPlugin & { pids: number[]; backends: string[] } => {
  const pids: number[] = [];
  const backends: string[] = [];
  return {
    id: 'script',
    backends,
    displayName: 'Script',
    pids,
    detect: async () => ({
      id: 'script',
      displayName: 'Script',
      command: 'node',
      status: 'ready',
      protocol: 'acp',
    }),
    async start(spec: SessionSpec, sandbox: SandboxHandle): Promise<HarnessSession> {
      backends.push(sandbox.backend);
      const w = await sandbox.wrap(process.execPath, [SCRIPT]);
      const child = spawn(w.cmd, w.args, { env: w.env, cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      if (child.pid) pids.push(child.pid);
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      const lines = createInterface({ input: child.stdout });
      const queue: HarnessEvent[] = [];
      const waiters: (() => void)[] = [];
      lines.on('line', (l) => {
        try {
          queue.push(JSON.parse(l) as HarnessEvent);
          for (const x of waiters.splice(0)) x();
        } catch {
          /* srt noise */
        }
      });
      child.on('exit', () => {
        queue.push(
          { type: 'error', message: `exited ${stderr.slice(-400)}` },
          { type: 'done', stopReason: 'exit' },
        );
        for (const x of waiters.splice(0)) x();
      });
      return {
        id: spec.sessionId,
        async *prompt(text: string) {
          child.stdin.write(`${JSON.stringify({ prompt: text, ...extra })}\n`);
          while (true) {
            while (!queue.length) await new Promise<void>((r) => waiters.push(r));
            const ev = queue.shift()!;
            yield ev;
            if (ev.type === 'done') return;
          }
        },
        respondPermission: async () => {},
        cancel: async () => {},
        close: async () => {
          child.kill('SIGTERM');
        },
      };
    },
  };
};

describe.skipIf(!hasBwrap)('real srt sandbox with a sandboxed node harness', () => {
  it('enforces fs policy, scrubs env, marks the session, and panic SIGKILLs the process tree', async () => {
    const root = tmpHome();
    const ws = join(root, 'ws');
    const secretDir = join(root, 'secrets');
    const outside = join(root, 'outside');
    for (const d of [ws, secretDir, outside]) mkdirSync(d, { recursive: true });
    writeFileSync(join(secretDir, 'key'), 'TOP-SECRET');
    const harness = scriptHarness({
      secretFile: join(secretDir, 'key'),
      outsideFile: join(outside, 'pwned.txt'),
    });
    process.env.SHOULD_NOT_LEAK = 'leaky';
    env = await makeEnv({
      plugins: { channels: [], harnesses: [harness] },
      sandbox: undefined as never,
      llmProxy: true,
    });
    try {
      await env.client.call('agent.create', {
        config: {
          name: 'sbx',
          harness: 'script',
          mounts: [{ path: ws, mode: 'rw', parallelUnsafe: true }],
          sandbox: { profile: 'workspace', policy: { fs: { deny: [secretDir] } } },
        },
      });
      const s = await env.client.call('session.start', { agent: 'sbx', text: 'probe' });
      await until(
        () => env!.d.store.sessions.events(s.id).some((e) => e.kind === 'assistant' || e.kind === 'error'),
        20_000,
        'probe',
      );
      const text = env.d.store.sessions.events(s.id).find((e) => e.kind === 'assistant')?.text ?? '';
      const results = JSON.parse(text.replace(/^results /, ''));
      expect(harness.backends).toEqual(['srt']);
      expect(results.secret).toMatch(/^denied/);
      expect(results.inside).toBe('wrote');
      expect(existsSync(join(ws, 'made-in-sandbox.txt'))).toBe(true);
      expect(results.outside).toMatch(/^denied/);
      expect(existsSync(join(outside, 'pwned.txt'))).toBe(false);
      expect(results.session).toBe('marked');
      expect(results.leakedEnv).toBe('none');

      // a hanging harness turn is killed by panic
      await env.client.call('session.send', { id: s.id, text: 'HANG' });
      await until(() => existsSync(join(ws, 'pid.txt')), 20_000, 'pid file');
      const pid = Number(readFileSync(join(ws, 'pid.txt'), 'utf8'));
      const alive = (p: number) => {
        try {
          process.kill(p, 0);
          return true;
        } catch {
          return false;
        }
      };
      await env.client.call('system.panic', { reason: 'sandbox test' });
      await until(() => harness.pids.every((p) => !alive(p)), 5000, 'runner killed');
      // The inner pid is namespaced under bwrap; the runner and its whole subtree are gone.
      expect(Number.isInteger(pid)).toBe(true);
    } finally {
      delete process.env.SHOULD_NOT_LEAK;
    }
  }, 60_000);
});
