// Core loop, end to end on this machine (no network): fake channel DM → router → a node harness
// running inside the REAL srt sandbox → broker (fake upstream) + beamhop MCP bridge → reply.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { MemorySecretStore } from '@beamhop/broker';
import type { HarnessEvent, HarnessPlugin, HarnessSession, SandboxHandle, SessionSpec } from '@beamhop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChannelPlugin, makeEnv, ownerAlice, setupBot, type TestEnv, tmpHome, until } from './helpers.ts';

const hasBwrap =
  process.platform === 'linux' && spawnSync('which', ['bwrap'], { stdio: 'ignore' }).status === 0;
const LOOP = fileURLToPath(new URL('./fixtures/loop-harness.mjs', import.meta.url));

const listen = async (s: Server): Promise<number> => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as AddressInfo).port;
};

/** Harness plugin that runs loop-harness.mjs inside the sandbox it is given. */
const loopHarness = (otherPort: number): HarnessPlugin & { backends: string[]; stderr: () => string } => {
  const backends: string[] = [];
  let err = '';
  return {
    id: 'script',
    displayName: 'Loop',
    backends,
    stderr: () => err,
    detect: async () => ({
      id: 'script',
      displayName: 'Loop',
      command: 'node',
      status: 'ready',
      protocol: 'acp',
    }),
    async start(spec: SessionSpec, sandbox: SandboxHandle): Promise<HarnessSession> {
      backends.push(sandbox.backend);
      const w = await sandbox.wrap(process.execPath, [LOOP]);
      const child = spawn(w.cmd, w.args, { env: w.env, cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.on('data', (d) => {
        err += d;
      });
      const queue: HarnessEvent[] = [];
      const waiters: (() => void)[] = [];
      createInterface({ input: child.stdout }).on('line', (l) => {
        try {
          queue.push(JSON.parse(l) as HarnessEvent);
          for (const x of waiters.splice(0)) x();
        } catch {
          /* noise */
        }
      });
      child.on('exit', () => {
        queue.push(
          { type: 'error', message: `exited ${err.slice(-400)}` },
          { type: 'done', stopReason: 'exit' },
        );
        for (const x of waiters.splice(0)) x();
      });
      return {
        id: spec.sessionId,
        async *prompt(text: string) {
          const nonce = /nonce=(\w+)/.exec(text)?.[1] ?? 'none';
          child.stdin.write(`${JSON.stringify({ mcpServers: spec.mcpServers, otherPort, nonce })}\n`);
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

let env: TestEnv | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await env?.close();
  env = undefined;
  for (const s of servers.splice(0)) s.close();
});

describe.skipIf(!hasBwrap)('core loop inside the real srt sandbox', () => {
  it('DM → sandboxed harness: broker injects the key, MCP tools work, own loopback works, other loopback is closed', async () => {
    // Fake LLM upstream (host side) that records which key the broker injected.
    const realKey = ['sk', 'test', randomBytes(12).toString('hex')].join('-');
    const seen: IncomingHttpHeaders[] = [];
    const upstream = createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'cmpl-1',
            model: 'fake-model',
            choices: [{ message: { role: 'assistant', content: 'from-fake-upstream' } }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
            keyOk: req.headers.authorization === `Bearer ${realKey}`,
          }),
        );
      });
    });
    const other = createServer((_q, r) => r.end('other-host-service'));
    servers.push(upstream, other);
    const upPort = await listen(upstream);
    const otherPort = await listen(other);

    const harness = loopHarness(otherPort);
    const channel = new FakeChannelPlugin();
    const work = join(tmpHome(), 'work');
    mkdirSync(work, { recursive: true });
    env = await makeEnv({
      channel,
      plugins: { channels: [channel], harnesses: [harness] },
      sandbox: undefined as never, // the daemon's real srt factory
      llmProxy: true,
      llmRoutes: [
        {
          id: 'openai',
          prefix: '/openai',
          upstream: `http://127.0.0.1:${upPort}`,
          secretName: 'OPENAI_API_KEY',
          auth: 'bearer',
        },
      ],
      secrets: new MemorySecretStore({ OPENAI_API_KEY: realKey }),
    });
    const conn = await setupBot(env, {
      harness: 'script',
      mounts: [{ path: work, mode: 'rw', parallelUnsafe: true }],
    });
    await ownerAlice(env);
    conn.inject({ text: 'run the probes nonce=n42' });

    await until(
      () => conn.textsTo('alice').some((t) => t.includes('results ') || t.includes('⚠️')),
      45_000,
      'reply',
    );
    const final = conn.textsTo('alice').find((t) => t.includes('results ')) ?? '';
    if (!final) console.log('[sent]', conn.textsTo('alice'), harness.stderr().slice(-2000));
    const r = JSON.parse(final.slice(final.indexOf('results ') + 8).trim());

    expect(harness.backends).toEqual(['srt']);
    // (a) broker: the sandbox only holds a placeholder; upstream saw the real key exactly once.
    expect(r.placeholderKey).not.toBe(realKey.slice(0, 6));
    expect(r.broker.status).toBe(200);
    expect(JSON.parse(r.broker.body).keyOk).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authorization).toBe(`Bearer ${realKey}`);
    // (b) MCP: the stdio server from SessionSpec.mcpServers starts inside and reaches the bridge.
    expect(r.mcpError).toBeUndefined();
    expect(r.mcpServer).toBe('beamhop');
    expect(r.mcpTools).toEqual(expect.arrayContaining(['channel_send', 'session_status']));
    expect(JSON.parse(r.sessionStatus).agent).toBe('bot');
    expect(r.channelSend).toMatch(/^sent message /);
    expect(conn.textsTo('alice')).toContain('progress note via MCP n42');
    // (c) the harness's own loopback server inside the sandbox works with node fetch and curl.
    expect(r.ownFetch.body).toBe('own-loopback');
    expect(r.ownCurl.stdout).toBe('own-loopback');
    // (d) every other host-loopback port is unreachable, directly or through srt's proxy.
    expect(r.otherFetch.error).toBeDefined();
    expect(r.otherCurlProxy.stdout).not.toContain('other-host-service');
    expect(r.otherCurlEnv.stdout).not.toContain('other-host-service');

    // The MCP tool call shows up as a session event.
    const [s] = env.d.store.sessions.list();
    const events = env.d.store.sessions.events(s!.id);
    expect(
      events.some((e) => e.kind === 'tool_call' && JSON.stringify(e.tool ?? '').includes('session_status')),
    ).toBe(true);
    // Broker usage reached the session budget accounting.
    await until(() => env!.d.store.usage.totals({ agent: 'bot' }).inputTokens >= 3, 5000, 'usage');
  }, 90_000);
});
