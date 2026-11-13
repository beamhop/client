// Live E2E: real OpenCode (npm opencode-ai, devDependency) over ACP, using OpenRouter.
// Run: pnpm vitest run -c vitest.live.config.ts packages/harness-acp
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform, tmpdir } from 'node:os';
import path from 'node:path';
import type { HarnessEvent, SandboxHandle, SessionSpec } from '@beamhop/core';
import { createLogger, SandboxPolicy } from '@beamhop/core';
import { afterAll, describe, expect, it } from 'vitest';
import { createAcpHarness } from '../src/index.ts';

// opencode's OpenRouter catalog does not list gemini-2.5-flash; gpt-4o-mini is $0.15/$0.60 per M tokens.
const MODEL = 'openrouter/openai/gpt-4o-mini';
const key = process.env.OPENROUTER_API_KEY;

/** Tiny local pass-through sandbox (the real one lives in packages/sandbox). */
const passthrough: SandboxHandle = {
  backend: 'passthrough',
  policy: SandboxPolicy.parse({}),
  wrap: async (cmd, args) => ({ cmd, args, env: {} }),
};

/** opencode-ai's postinstall does not run under pnpm, so resolve the platform binary package directly. */
const opencodeBinary = (): string => {
  const req = createRequire(createRequire(import.meta.url).resolve('opencode-ai/package.json'));
  const os = platform() === 'win32' ? 'windows' : platform();
  const exe = os === 'windows' ? 'opencode.exe' : 'opencode';
  for (const variant of ['', '-baseline']) {
    try {
      const pkg = req.resolve(`opencode-${os}-${arch()}${variant}/package.json`);
      const bin = path.join(path.dirname(pkg), 'bin', exe);
      if (existsSync(bin)) return bin;
    } catch {
      // try next
    }
  }
  throw new Error('opencode platform binary not installed');
};

/** Egress proxy + CA settings of the host (what a real sandbox would inject). Upper-case only:
 * passing both HTTPS_PROXY and https_proxy made opencode's Bun runtime hang on requests. */
const proxyEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of ['HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
};

const root = mkdtempSync(path.join(tmpdir(), 'beamhop-oc-live-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** Start opencode over ACP, ask for "pong", return events + adapter logs. `model` '' keeps opencode's default. */
const runPong = async (model: string) => {
  n += 1;
  const home = path.join(root, `home${n}`);
  const work = path.join(root, `work${n}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, 'opencode.json'), JSON.stringify({ autoupdate: false, share: 'disabled' }));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    ...proxyEnv(),
  };
  if (key) env.OPENROUTER_API_KEY = key;
  const spec: SessionSpec = {
    sessionId: `live-oc-${n}`,
    agent: 'live',
    model,
    cwd: work,
    mounts: [{ path: work, mode: 'rw' }],
    permissionMode: 'ask',
    env,
    mcpServers: [],
  };
  const logs: string[] = [];
  const harness = createAcpHarness({
    id: 'opencode',
    displayName: 'OpenCode',
    command: opencodeBinary(),
    args: ['acp'],
    detect: async () => null,
    startTimeoutMs: 90000,
    log: createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
  });
  const session = await harness.start(spec, passthrough);
  try {
    const events: HarnessEvent[] = [];
    for await (const ev of session.prompt('Reply with the single word pong and nothing else. Do not use tools.')) {
      events.push(ev);
      if (ev.type === 'permission_request') await session.respondPermission(ev.id, { allow: false });
    }
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    console.log(`[opencode live ${model || 'default'}]`, events.map((e) => JSON.stringify(e)).join(' '));
    return { events, text, logs, id: session.id };
  } finally {
    await session.close();
  }
};

describe('opencode over ACP (live)', () => {
  it.runIf(Boolean(key))('replies pong via OpenRouter', async () => {
    const r = await runPong(MODEL);
    expect(r.events.find((e) => e.type === 'error')).toBeUndefined();
    expect(r.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
    expect(r.text.toLowerCase()).toContain('pong');
    // the requested OpenRouter model was selected via ACP session config options
    expect(r.logs.join('\n')).not.toMatch(/model not offered|could not set model/);
  });

  // Same path with opencode's own default (free) model: proves the real-agent ACP flow
  // independently of the OpenRouter key.
  it('replies pong with the opencode default model', async () => {
    const r = await runPong('');
    expect(r.events.find((e) => e.type === 'error')).toBeUndefined();
    expect(r.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
    expect(r.text.toLowerCase()).toContain('pong');
    expect(r.id).toMatch(/^ses_/);
  });
});
