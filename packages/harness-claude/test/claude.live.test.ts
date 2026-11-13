// Live E2E: real Claude Code (bundled with @anthropic-ai/claude-agent-sdk) spawned through a
// pass-through SandboxHandle. Needs Anthropic credentials; opt in with BEAMHOP_LIVE_CLAUDE=1.
// Run: BEAMHOP_LIVE_CLAUDE=1 pnpm vitest run -c vitest.live.config.ts packages/harness-claude
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type HarnessEvent, type SandboxHandle, SandboxPolicy } from '@beamhop/core';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeHarness } from '../src/index.ts';

const root = mkdtempSync(path.join(tmpdir(), 'beamhop-claude-live-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.runIf(process.env.BEAMHOP_LIVE_CLAUDE === '1')('claude via Agent SDK (live)', () => {
  it('replies pong through the sandbox-wrapped spawn', async () => {
    const work = path.join(root, 'w');
    mkdirSync(work, { recursive: true });
    const wrapped: string[] = [];
    const sandbox: SandboxHandle = {
      backend: 'passthrough',
      policy: SandboxPolicy.parse({}),
      wrap: async (cmd, args) => {
        wrapped.push(cmd);
        return { cmd, args, env: {} };
      },
    };
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? root };
    for (const k of [
      'ANTHROPIC_API_KEY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'SSL_CERT_FILE',
      'NODE_EXTRA_CA_CERTS',
    ]) {
      const v = process.env[k];
      if (v) env[k] = v;
    }
    const s = await claudeHarness().start(
      {
        sessionId: 'live',
        agent: 'live',
        model: 'claude-haiku-4-5',
        cwd: work,
        mounts: [{ path: work, mode: 'rw' }],
        permissionMode: 'ask',
        env,
        mcpServers: [],
      },
      sandbox,
    );
    try {
      const evs: HarnessEvent[] = [];
      for await (const ev of s.prompt('Reply with the single word pong and nothing else.')) evs.push(ev);
      const text = evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
      expect(text.toLowerCase()).toContain('pong');
      expect(evs.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
      expect(wrapped).toHaveLength(1);
    } finally {
      await s.close();
    }
  });
});
