/**
 * A REAL daemon for end-to-end tests of other apps (the PWA's `e2e-real` Playwright suite), with a
 * fake channel plugin and a scripted fake harness injected so tests can drive inbound messages and
 * harness events deterministically. Lives under `test/` so it is never part of a production build.
 *
 *   const td = await startTestDaemon({ port: 4600, staticDir: 'apps/pwa/dist' });
 *   td.inject({ text: 'ASK git push origin main' });   // owner DM on the fake channel
 *
 * Harness script (the text of the user message, after the beamhop preamble):
 *   - `ASK <command>`   → tool_call + permission_request for `bash <command>`, waits for the decision,
 *                         then answers `allowed: <command>` or `refused: <reason>`.
 *   - `STREAM <n>`      → n text chunks ~150 ms apart (`chunk-1 chunk-2 …`).
 *   - `HANG`            → `working…`, then waits until the session is cancelled (panic / stop).
 *   - anything else     → `reply: <text>`.
 *   Every turn also reports usage (1200 in / 300 out tokens, $0.02).
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore } from '@beamhop/broker';
import { type InboundMsg, type InboundMsgInput, silentLogger } from '@beamhop/core';
import { createDaemon, type Daemon, type DaemonOptions, type SandboxFactory } from '../src/index.ts';
import {
  body,
  FakeChannelPlugin,
  type FakeConn,
  FakeHarnessPlugin,
  type FakeHarnessSession,
  fakeSandbox,
  type Script,
} from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The deterministic script described in the header. */
export const scriptedHarness: Script = async function* (s, prompt) {
  const text = body(prompt).trim();
  yield { type: 'usage', inputTokens: 1200, outputTokens: 300, costUsd: 0.02 };
  const ask = /^ASK\s+(.+)$/s.exec(text);
  if (ask) {
    const command = ask[1]!.trim();
    const id = `p${s.prompts.length}`;
    yield { type: 'tool_call', id: `t${id}`, name: 'bash', input: { command }, title: `Run ${command}` };
    yield { type: 'permission_request', id, tool: 'bash', input: { command }, title: `Run ${command}` };
    const d = await s.waitPermission(id);
    yield { type: 'tool_result', id: `t${id}`, ok: d.allow, output: d.allow ? 'done' : '' };
    yield { type: 'text', delta: d.allow ? `allowed: ${command}` : `refused: ${d.reason ?? 'denied'}` };
    yield { type: 'done', stopReason: 'end_turn' };
    return;
  }
  const stream = /^STREAM\s+(\d+)/.exec(text);
  if (stream) {
    const n = Math.min(50, Number(stream[1]));
    for (let i = 1; i <= n; i++) {
      yield { type: 'text', delta: `chunk-${i} ` };
      await sleep(150);
    }
    yield { type: 'done', stopReason: 'end_turn' };
    return;
  }
  if (text.startsWith('HANG')) {
    yield { type: 'progress', message: 'thinking hard…' };
    yield { type: 'text', delta: 'working…' };
    await s.waitCancel();
    yield { type: 'done', stopReason: 'cancelled' };
    return;
  }
  yield { type: 'text', delta: `reply: ${text.slice(0, 200)}` };
  yield { type: 'done', stopReason: 'end_turn', resume: `resume-${s.id}` };
};

export interface TestDaemonOptions {
  port?: number;
  host?: string;
  staticDir?: string;
  /** Undo window for approval decisions (default 5 s, the PWA's toast). */
  approvalUndoMs?: number;
  /** Housekeeping interval (approval expiry etc.; default 250 ms). */
  tickMs?: number;
  /** Seed: fake channel `fk`, agent `bot` on `fk:dm`, owner `fake:alice` (default true). */
  seed?: boolean;
  daemon?: Partial<DaemonOptions>;
}

export interface TestDaemon {
  d: Daemon;
  url: string;
  token: string;
  home: string;
  channel: FakeChannelPlugin;
  harness: FakeHarnessPlugin;
  /** Clock offset in ms added to Date.now() (advance to expire approvals). */
  clock: { offset: number };
  conn(name?: string): FakeConn;
  /** Inbound message on a fake channel (default: owner DM from `fake:alice` on `fk`). */
  inject(m: Partial<InboundMsgInput> & { text: string; channel?: string }): InboundMsg;
  /** Report a sandbox violation from every live session sandbox (as the real sandbox would). */
  violate(v: { kind: 'net.allow' | 'fs.read' | 'fs.write'; value: string }): number;
  /** Advance the daemon clock and run housekeeping (approval expiry, schedules). */
  advance(ms: number): Promise<void>;
  /** Plain-JSON snapshot of what the fakes saw. */
  snapshot(): {
    sent: Record<string, { conversation: string; text: string; buttons: string[] }[]>;
    harness: {
      id: string;
      agent: string;
      prompts: string[];
      decisions: Record<string, { allow: boolean; reason?: string }>;
      cancelled: number;
      closed: boolean;
    }[];
  };
  stop(): Promise<void>;
}

export const SEED_AGENT = 'bot';
export const SEED_CHANNEL = 'fk';
export const SEED_OWNER = 'fake:alice';

/** Fake channel provider credential that validates (built at runtime: no token-shaped literals). */
export const GOOD_FAKE_TOKEN = ['go', 'od'].join('');

export const startTestDaemon = async (opts: TestDaemonOptions = {}): Promise<TestDaemon> => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bh-e2e-real-')));
  const channel = new FakeChannelPlugin();
  // Any token starting with "good" validates (so a test can use a distinctive value and check it
  // is never echoed back); everything else is refused like a provider would.
  channel.setup = {
    ...channel.setup,
    validate: async (_v, s) =>
      (s.token ?? '').startsWith(GOOD_FAKE_TOKEN)
        ? { ok: true, message: 'ok', identity: { name: 'Beam Bot' } }
        : { ok: false, message: 'bad token' },
  };
  const harness = new FakeHarnessPlugin(scriptedHarness);
  const clock = { offset: 0 };
  type Violation = { kind: 'net.allow' | 'fs.read' | 'fs.write'; value: string; allowed?: boolean };
  const violationSinks = new Set<(v: Violation) => void>();
  const sandbox: SandboxFactory = async (policy, o) => {
    const sb = await fakeSandbox(policy, o);
    let sink: ((v: Violation) => void) | undefined;
    return {
      ...sb,
      onViolation: (cb) => {
        sink = cb;
        violationSinks.add(cb);
        return () => violationSinks.delete(cb);
      },
      close: async () => {
        if (sink) violationSinks.delete(sink);
        await sb.close();
      },
    };
  };
  const d = await createDaemon({
    home,
    log: silentLogger,
    now: () => Date.now() + clock.offset,
    secrets: new MemorySecretStore(),
    dataKey: Buffer.alloc(32, 9),
    plugins: { channels: [channel], harnesses: [harness] },
    api: {
      port: opts.port ?? 0,
      host: opts.host ?? '127.0.0.1',
      ...(opts.staticDir ? { staticDir: opts.staticDir } : {}),
    },
    socket: false,
    llmProxy: false,
    sandbox,
    tickMs: opts.tickMs ?? 250,
    approvalUndoMs: opts.approvalUndoMs ?? 5000,
    editThrottleMs: 20,
    controlPlane: false,
    env: {},
    ...opts.daemon,
  });
  if (opts.seed !== false) {
    await d.call('channel.add', {
      name: SEED_CHANNEL,
      provider: 'fake',
      values: {},
      secrets: { token: GOOD_FAKE_TOKEN },
    });
    await d.call('owner.add', { principal: SEED_OWNER });
    await d.call('agent.create', {
      config: {
        name: SEED_AGENT,
        displayName: 'Bot',
        harness: 'fake',
        approvalTimeoutMinutes: 1,
        memberships: [{ target: `${SEED_CHANNEL}:dm`, defaultRole: 'viewer', triggers: ['dm', 'mention'] }],
      },
    });
  }
  const conn = (name = SEED_CHANNEL) => channel.conn(name);
  const url = d.api?.url ?? '';
  return {
    d,
    url,
    token: d.apiToken,
    home,
    channel,
    harness,
    clock,
    conn,
    inject: ({ channel: ch, ...m }) => conn(ch).inject(m),
    violate: (v) => {
      for (const cb of violationSinks) cb({ ...v, allowed: false });
      return violationSinks.size;
    },
    advance: async (ms) => {
      clock.offset += ms;
      await d.tick();
    },
    snapshot: () => ({
      sent: Object.fromEntries(
        [...channel.conns.entries()].map(([name, c]) => [
          name,
          c.sent.map((s) => ({
            conversation: s.msg.conversation.id,
            text: s.text,
            buttons: (s.msg.buttons ?? []).map((b) => b.id),
          })),
        ]),
      ),
      harness: harness.sessions.map((s: FakeHarnessSession) => ({
        id: s.id,
        agent: s.spec.agent,
        prompts: s.prompts.map(body),
        decisions: Object.fromEntries(
          [...s.decisions.entries()].map(([k, v]) => [
            k,
            { allow: v.allow, ...(v.reason ? { reason: v.reason } : {}) },
          ]),
        ),
        cancelled: s.cancelled,
        closed: s.closed,
      })),
    }),
    stop: async () => {
      await d.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
};
