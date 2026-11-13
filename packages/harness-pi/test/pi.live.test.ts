// Live E2E: real pi (npm @mariozechner/pi-coding-agent, devDependency) in RPC mode, via OpenRouter.
// Run: pnpm vitest run -c vitest.live.config.ts packages/harness-pi
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HarnessEvent, SandboxPolicy, type SandboxHandle, type SessionSpec } from '@beamhop/core';
import { afterAll, describe, expect, it } from 'vitest';
import { piHarness } from '../src/index.ts';

const MODEL = 'openrouter/openai/gpt-4o-mini';
const key = process.env.OPENROUTER_API_KEY;

/** Tiny local pass-through sandbox (the real one lives in packages/sandbox). */
const passthrough: SandboxHandle = {
  backend: 'passthrough',
  policy: SandboxPolicy.parse({}),
  wrap: async (cmd, args) => ({ cmd, args, env: {} }),
};

const piBin = fileURLToPath(
  new URL(`../node_modules/.bin/pi${process.platform === 'win32' ? '.cmd' : ''}`, import.meta.url),
);

const proxyEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of ['HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
};

const root = mkdtempSync(path.join(tmpdir(), 'beamhop-pi-live-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const makeSpec = (model: string): SessionSpec => {
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
    PI_SKIP_VERSION_CHECK: '1',
    ...proxyEnv(),
  };
  if (key) env.OPENROUTER_API_KEY = key;
  return {
    sessionId: 'live-pi',
    agent: 'live',
    model,
    cwd: work,
    mounts: [{ path: work, mode: 'rw' }],
    permissionMode: 'ask',
    env,
    mcpServers: [],
  };
};

describe('pi over RPC (live)', () => {
  it('starts the real pi in RPC mode with the approval gate and reports a session', async () => {
    const s = await piHarness({ command: piBin, startTimeoutMs: 90000 }).start(makeSpec(MODEL), passthrough);
    try {
      expect(s.id).toMatch(/[0-9a-f-]{8,}/);
    } finally {
      await s.close();
    }
  });

  it.runIf(Boolean(key))('replies pong via OpenRouter', async () => {
    const s = await piHarness({ command: piBin, startTimeoutMs: 90000 }).start(makeSpec(MODEL), passthrough);
    try {
      const events: HarnessEvent[] = [];
      for await (const ev of s.prompt('Reply with the single word pong and nothing else. Do not use tools.')) {
        events.push(ev);
        if (ev.type === 'permission_request') await s.respondPermission(ev.id, { allow: false });
      }
      console.log('[pi live]', events.map((e) => JSON.stringify(e)).join(' '));
      const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
      expect(events.find((e) => e.type === 'error')).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
      expect(text.toLowerCase()).toContain('pong');
    } finally {
      await s.close();
    }
  });
});
