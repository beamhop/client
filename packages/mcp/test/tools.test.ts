import { request } from 'node:http';
import { BeamhopError, silentLogger } from '@beamhop/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBridgeClient,
  createMcpBridge,
  LIMITS,
  mcpServerSpec,
  nextHop,
  parseToolInput,
  readBridgeEnv,
  TOOL_NAMES,
} from '../src/index.ts';
import { defaultCtx, fakeHandlers, type Harness, NPUB, setup, text } from './helpers.ts';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('tool catalogue', () => {
  it('lists all tools with descriptions and object input schemas', async () => {
    h = await setup();
    const client = await h.connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
    }
    const history = tools.find((t) => t.name === 'channel_history')!;
    expect(Object.keys(history.inputSchema.properties ?? {})).toEqual(['limit', 'before']);
    expect(tools.find((t) => t.name === 'channel_history')?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('channel tools', () => {
  it('channel_send defaults to the current conversation and passes the session ctx', async () => {
    h = await setup();
    const client = await h.connect();
    const r = await client.callTool({ name: 'channel_send', arguments: { markdown: '**hi**' } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('sent message msg_1 to mybot:dm/42');
    expect(h.calls[0]).toMatchObject({ tool: 'channel_send', input: { markdown: '**hi**' } });
    expect(h.calls[0]!.ctx.sessionId).toBe('ses_1');
  });

  it('channel_send to a routed target works, unrouted target is a tool error', async () => {
    h = await setup();
    const client = await h.connect();
    const ok = await client.callTool({
      name: 'channel_send',
      arguments: { markdown: 'x', target: 'work-slack:channel/C0123' },
    });
    expect(text(ok)).toContain('work-slack:channel/C0123');
    const denied = await client.callTool({
      name: 'channel_send',
      arguments: { markdown: 'x', target: 'other:group/-1' },
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toBe('forbidden: no route from mybot:dm/42 to other:group/-1');
  });

  it('channel_send rejects malformed targets and markdown over 20k chars', async () => {
    h = await setup();
    const client = await h.connect();
    const bad = await client.callTool({
      name: 'channel_send',
      arguments: { markdown: 'x', target: 'not a target' },
    });
    expect(bad.isError).toBe(true);
    const ok = await client.callTool({
      name: 'channel_send',
      arguments: { markdown: 'a'.repeat(LIMITS.markdownMaxChars) },
    });
    expect(ok.isError).toBeFalsy();
    const big = await client.callTool({
      name: 'channel_send',
      arguments: { markdown: 'a'.repeat(LIMITS.markdownMaxChars + 1) },
    });
    expect(big.isError).toBe(true);
    expect(text(big)).toMatch(/markdown/);
    const empty = await client.callTool({ name: 'channel_send', arguments: { markdown: '' } });
    expect(empty.isError).toBe(true);
    expect(h.calls).toHaveLength(1);
  });

  it('channel_send_file: inside session dir / mount ok, outside is sandbox_violation', async () => {
    h = await setup();
    const client = await h.connect();
    const ctx = defaultCtx();
    const ok = await client.callTool({
      name: 'channel_send_file',
      arguments: { path: `${ctx.sessionDir}/out/shot.png`, caption: 'screenshot' },
    });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(text(ok))).toMatchObject({ messageId: 'msg_2' });
    const outside = await client.callTool({
      name: 'channel_send_file',
      arguments: { path: `${ctx.sessionDir}/../../../etc/passwd` },
    });
    expect(outside.isError).toBe(true);
    expect(text(outside)).toMatch(/^sandbox_violation:/);
  });

  it('channel_history clamps limit to 50 and defaults to 20', async () => {
    h = await setup();
    const client = await h.connect();
    const r = await client.callTool({ name: 'channel_history', arguments: { limit: 500, before: 'm99' } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).messages).toHaveLength(LIMITS.historyMax);
    expect(h.calls[0]!.input).toEqual({ limit: 50, before: 'm99' });
    await client.callTool({ name: 'channel_history', arguments: {} });
    expect(h.calls[1]!.input).toEqual({ limit: 20 });
    const zero = await client.callTool({ name: 'channel_history', arguments: { limit: 0 } });
    expect(zero.isError).toBe(true);
    const frac = await client.callTool({ name: 'channel_history', arguments: { limit: 2.5 } });
    expect(frac.isError).toBe(true);
  });

  it('channel_members and session_status return JSON text', async () => {
    h = await setup();
    const client = await h.connect();
    const m = await client.callTool({ name: 'channel_members', arguments: {} });
    expect(JSON.parse(text(m))).toEqual([{ name: 'Alice', principal: 'telegram:5551', role: 'owner' }]);
    const s = await client.callTool({ name: 'session_status' });
    expect(JSON.parse(text(s))).toMatchObject({ role: 'user', permissionMode: 'ask' });
  });
});

describe('mesh tools', () => {
  it('mesh_list_agents forwards the query', async () => {
    h = await setup();
    const client = await h.connect();
    const r = await client.callTool({ name: 'mesh_list_agents', arguments: { query: 'review' } });
    expect(JSON.parse(text(r)).agents[0].npub).toBe(NPUB);
    expect(h.calls[0]!.input).toEqual({ query: 'review' });
  });

  it('mesh_ask_agent adds one hop and applies the default timeout', async () => {
    h = await setup(defaultCtx({ hops: 1 }));
    const client = await h.connect();
    const r = await client.callTool({ name: 'mesh_ask_agent', arguments: { npub: NPUB, question: 'ping?' } });
    expect(text(r)).toBe(`reply from ${NPUB} (hops=2)`);
    expect(h.calls[0]!.input).toEqual({ npub: NPUB, question: 'ping?', timeoutSeconds: 120, hops: 2 });
  });

  it('mesh_ask_agent fails cleanly at the hop limit and on bad input', async () => {
    h = await setup(defaultCtx({ hops: 3, maxHops: 3 }));
    const client = await h.connect();
    const r = await client.callTool({
      name: 'mesh_ask_agent',
      arguments: { npub: NPUB, question: 'again?' },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^forbidden: hop limit reached/);
    const badNpub = await client.callTool({
      name: 'mesh_ask_agent',
      arguments: { npub: 'npub1xyz', question: 'q' },
    });
    expect(badNpub.isError).toBe(true);
    const tooLong = await client.callTool({
      name: 'mesh_ask_agent',
      arguments: { npub: NPUB, question: 'q', timeoutSeconds: 10_000 },
    });
    expect(tooLong.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it('mesh_post_job validates the kind range and returns a job id; mesh_job_result fetches it', async () => {
    h = await setup();
    const client = await h.connect();
    for (const kind of [4999, 6000, 5000.5]) {
      const r = await client.callTool({ name: 'mesh_post_job', arguments: { kind, input: 'x' } });
      expect(r.isError).toBe(true);
    }
    const r = await client.callTool({
      name: 'mesh_post_job',
      arguments: { kind: 5050, input: 'summarize', peer: NPUB },
    });
    expect(JSON.parse(text(r))).toEqual({ jobId: 'job_1', status: 'pending' });
    expect(h.calls[0]!.input).toEqual({ kind: 5050, input: 'summarize', peer: NPUB, inputType: 'text' });
    const res = await client.callTool({ name: 'mesh_job_result', arguments: { jobId: 'job_1' } });
    expect(JSON.parse(text(res))).toMatchObject({ status: 'success', content: '42' });
    expect(h.calls[1]!.input).toEqual({ jobId: 'job_1', waitSeconds: 0 });
    const missing = await client.callTool({ name: 'mesh_job_result', arguments: { jobId: 'nope' } });
    expect(text(missing)).toBe('not_found: unknown job');
  });
});

describe('auth and errors', () => {
  it('a bad token yields an unauthorized tool error, not a protocol error', async () => {
    h = await setup();
    const client = await h.connect('not-the-token');
    const r = await client.callTool({ name: 'session_status' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^unauthorized:/);
    expect(h.calls).toHaveLength(0);
  });

  it('removing a session revokes its token and aborts in-flight calls', async () => {
    let seen: AbortSignal | undefined;
    h = await setup(defaultCtx(), (calls) => ({
      ...fakeHandlers(calls),
      mesh_ask_agent: (_ctx, _input, meta) =>
        new Promise((_, reject) => {
          seen = meta.signal;
          meta.signal.addEventListener('abort', () =>
            reject(new BeamhopError('unavailable', 'session ended')),
          );
        }),
    }));
    const client = await h.connect();
    const pending = client.callTool({ name: 'mesh_ask_agent', arguments: { npub: NPUB, question: 'q' } });
    await vi_waitFor(() => seen !== undefined);
    expect(h.bridge.removeSession(h.token)).toBe(true);
    const r = await pending;
    expect(seen?.aborted).toBe(true);
    expect(text(r)).toBe('unavailable: session ended');
    const after = await client.callTool({ name: 'session_status' });
    expect(text(after)).toMatch(/^unauthorized:/);
    expect(h.bridge.removeSession(h.token)).toBe(false);
  });

  it('handler crashes are reported generically without leaking details', async () => {
    h = await setup(defaultCtx(), (calls) => ({
      ...fakeHandlers(calls),
      session_status: async () => {
        throw new Error('db password=hunter2 failed');
      },
    }));
    const client = await h.connect();
    const r = await client.callTool({ name: 'session_status' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('internal: internal error while running session_status');
  });

  it('an unreachable bridge is a clean tool error', async () => {
    const bridge = await createMcpBridge({ handlers: fakeHandlers([]), log: silentLogger });
    const url = bridge.url;
    await bridge.close();
    const call = createBridgeClient({ url, token: 't' });
    expect(await call('session_status', {})).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'beamhop daemon bridge is unreachable' },
    });
    h = await setup();
  });

  it('truncates huge handler results', async () => {
    h = await setup(defaultCtx(), (calls) => ({
      ...fakeHandlers(calls),
      session_status: async () => 'x'.repeat(LIMITS.resultMaxChars + 10),
    }));
    const client = await h.connect();
    const r = await client.callTool({ name: 'session_status' });
    expect(text(r).length).toBeLessThan(LIMITS.resultMaxChars + 100);
    expect(text(r)).toMatch(/truncated 10 chars/);
  });
});

/** Raw HTTP to the bridge, so we can set Host/Origin and send arbitrary bodies. */
const raw = (
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<{
  status: number;
  body: { ok: boolean; error?: { code: string; message: string }; text?: string };
}> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/v1/call',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });

describe('bridge HTTP hardening', () => {
  const json = (token: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...extra,
  });

  it('accepts a well-formed call and re-validates input (bypassing the MCP server)', async () => {
    h = await setup();
    const port = h.bridge.port;
    const ok = await raw(port, {
      headers: json(h.token),
      body: JSON.stringify({ tool: 'session_status', input: {} }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    const big = await raw(port, {
      headers: json(h.token),
      body: JSON.stringify({
        tool: 'channel_send',
        input: { markdown: 'a'.repeat(LIMITS.markdownMaxChars + 1) },
      }),
    });
    expect(big.status).toBe(400);
    expect(big.body.error?.code).toBe('invalid_input');
    const extra = await raw(port, {
      headers: json(h.token),
      body: JSON.stringify({ tool: 'channel_members', input: { secret: 1 } }),
    });
    expect(extra.body.error?.code).toBe('invalid_input');
    expect(h.calls.map((c) => c.tool)).toEqual(['session_status']);
  });

  it('rejects bad tokens, unknown tools, wrong methods/paths, Origin, foreign Host, non-JSON and huge bodies', async () => {
    h = await setup();
    const port = h.bridge.port;
    const body = JSON.stringify({ tool: 'session_status', input: {} });
    expect((await raw(port, { headers: json('nope'), body })).status).toBe(401);
    expect((await raw(port, { headers: { 'content-type': 'application/json' }, body })).status).toBe(401);
    expect(
      (await raw(port, { headers: json(h.token), body: JSON.stringify({ tool: '__proto__' }) })).status,
    ).toBe(400);
    expect((await raw(port, { headers: json(h.token), body: 'not json' })).status).toBe(400);
    expect((await raw(port, { method: 'GET', headers: json(h.token) })).status).toBe(405);
    expect((await raw(port, { path: '/other', headers: json(h.token), body })).status).toBe(404);
    expect(
      (await raw(port, { headers: json(h.token, { origin: 'https://evil.example' }), body })).status,
    ).toBe(403);
    expect((await raw(port, { headers: json(h.token, { host: 'evil.example' }), body })).status).toBe(403);
    expect(
      (
        await raw(port, {
          headers: { authorization: `Bearer ${h.token}`, 'content-type': 'text/plain' },
          body,
        })
      ).status,
    ).toBe(415);
    const huge = await raw(port, {
      headers: json(h.token),
      body: Buffer.alloc(LIMITS.bridgeMaxBodyBytes + 10, 'a'),
    }).catch(() => ({ status: 413 }));
    expect([400, 413]).toContain(huge.status);
    expect(h.calls).toHaveLength(0);
  });

  it('issues distinct high-entropy tokens per session and maps each to its ctx', async () => {
    h = await setup();
    const t2 = h.bridge.addSession(defaultCtx({ sessionId: 'ses_2' }));
    expect(t2).not.toBe(h.token);
    expect(t2.length).toBeGreaterThanOrEqual(43);
    expect(h.bridge.sessionCount).toBe(2);
    const client = await h.connect(t2);
    await client.callTool({ name: 'session_status' });
    expect(h.calls[0]!.ctx.sessionId).toBe('ses_2');
  });
});

describe('helpers', () => {
  it('nextHop increments and enforces the limit', () => {
    expect(nextHop(0, 3)).toBe(1);
    expect(nextHop(2, 3)).toBe(3);
    expect(() => nextHop(3, 3)).toThrow(/hop limit/);
  });

  it('parseToolInput rejects unknown keys and applies defaults', () => {
    expect(parseToolInput('channel_history', { limit: 99 })).toEqual({ limit: 50 });
    expect(() => parseToolInput('session_status', { x: 1 })).toThrow(/invalid arguments/);
  });

  it('readBridgeEnv requires a loopback http URL and a token', () => {
    expect(readBridgeEnv({})).toHaveProperty('error');
    expect(readBridgeEnv({ BEAMHOP_MCP_URL: 'http://127.0.0.1:1', BEAMHOP_MCP_TOKEN: 't' })).toEqual({
      url: 'http://127.0.0.1:1',
      token: 't',
    });
    expect(
      readBridgeEnv({ BEAMHOP_MCP_URL: 'http://evil.example:1', BEAMHOP_MCP_TOKEN: 't' }),
    ).toHaveProperty('error');
    expect(readBridgeEnv({ BEAMHOP_MCP_URL: 'https://127.0.0.1:1', BEAMHOP_MCP_TOKEN: 't' })).toHaveProperty(
      'error',
    );
  });

  it('mcpServerSpec returns a node command with url + token env', () => {
    const spec = mcpServerSpec('tok', 'http://127.0.0.1:9');
    expect(spec.name).toBe('beamhop');
    expect(spec.command).toBe(process.execPath);
    expect(spec.env).toEqual({ BEAMHOP_MCP_URL: 'http://127.0.0.1:9', BEAMHOP_MCP_TOKEN: 'tok' });
    expect(spec.args[0]).toBe('--import');
    expect(spec.args[1]).toMatch(/^file:\/\/.*tsx/);
    expect(spec.args[2]).toMatch(/beamhop-mcp\.ts$/);
  });
});

const vi_waitFor = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
