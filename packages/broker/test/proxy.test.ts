import { createServer, type IncomingHttpHeaders, request, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createLlmProxy,
  createSseParser,
  envForHarness,
  foldUsage,
  type LlmProxy,
  type LlmRoute,
  MemorySecretStore,
  piModelsJson,
  type UsageEvent,
} from '../src/index.ts';

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const ANTHROPIC_KEY = 'sk-ant-api03-REAL-anthropic-key-for-tests-only';
const OPENAI_KEY = 'sk-proj-REAL-openai-key-for-tests-0001';
const OPENROUTER_KEY = 'sk-or-v1-real-openrouter-key';

describe('createLlmProxy', () => {
  let upstream: Server;
  let upstreamUrl = '';
  let seen: Seen[] = [];
  let handler: (res: ServerResponse, s: Seen) => void = (res) => res.end('{}');
  let proxy: LlmProxy;
  const usage: UsageEvent[] = [];
  let budgetOk = true;
  const secrets = new MemorySecretStore({
    ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    OPENAI_API_KEY: OPENAI_KEY,
    OPENROUTER_API_KEY: OPENROUTER_KEY,
  });

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const s = { method: req.method, url: req.url, headers: req.headers, body };
        seen.push(s);
        handler(res, s);
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const routes: LlmRoute[] = [
      {
        id: 'anthropic',
        prefix: '/anthropic',
        upstream: upstreamUrl,
        secretName: 'ANTHROPIC_API_KEY',
        auth: 'x-api-key',
      },
      {
        id: 'openai',
        prefix: '/openai',
        upstream: upstreamUrl,
        secretName: 'OPENAI_API_KEY',
        auth: 'bearer',
        injectStreamUsage: true,
      },
      {
        id: 'openrouter',
        prefix: '/openrouter',
        upstream: `${upstreamUrl}/or-base`,
        secretName: 'OPENROUTER_API_KEY',
        auth: 'bearer',
        injectStreamUsage: true,
      },
      { id: 'nokey', prefix: '/nokey', upstream: upstreamUrl, secretName: 'MISSING', auth: 'bearer' },
    ];
    proxy = await createLlmProxy({
      secrets,
      routes,
      onUsage: (u) => usage.push(u),
      checkBudget: () => budgetOk,
    });
  });
  afterAll(async () => {
    await proxy.close();
    upstream.close();
  });
  beforeEach(() => {
    seen = [];
    usage.length = 0;
    budgetOk = true;
    handler = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    };
  });

  it('listens on 127.0.0.1 with a random port', () => {
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(proxy.port).toBeGreaterThan(0);
  });

  it('rejects requests without a valid session placeholder (401)', async () => {
    const none = await fetch(`${proxy.url}/anthropic/v1/messages`, { method: 'POST', body: '{}' });
    expect(none.status).toBe(401);
    const bogus = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'bh-sess-guessed', authorization: 'Bearer sk-real-looking' },
      body: '{}',
    });
    expect(bogus.status).toBe(401);
    const t = proxy.createSession();
    proxy.revokeSession(t);
    const revoked = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      headers: { 'x-beamhop-session': t },
    });
    expect(revoked.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('strips client auth headers and injects x-api-key for anthropic', async () => {
    const t = proxy.createSession('s1');
    const r = await fetch(`${proxy.url}/anthropic/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': t,
        authorization: 'Bearer something-else',
        cookie: 'a=b',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-x', messages: [] }),
    });
    expect(r.status).toBe(200);
    const s = seen[0]!;
    expect(s.url).toBe('/v1/messages?beta=true');
    expect(s.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(s.headers.authorization).toBeUndefined();
    expect(s.headers.cookie).toBeUndefined();
    expect(s.headers['x-beamhop-session']).toBeUndefined();
    expect(s.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.stringify(s.headers)).not.toContain(t);
  });

  it('injects a Bearer token for openai and openrouter (with base path)', async () => {
    const t = proxy.createSession();
    await fetch(`${proxy.url}/openai/v1/models`, {
      headers: { authorization: `Bearer ${t}`, 'x-api-key': 'junk' },
    });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(seen[0]!.headers['x-api-key']).toBeUndefined();
    expect(seen[0]!.url).toBe('/v1/models');
    await fetch(`${proxy.url}/openrouter/api/v1/models`, { headers: { 'x-beamhop-session': t } });
    expect(seen[1]!.headers.authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
    expect(seen[1]!.url).toBe('/or-base/api/v1/models');
  });

  it('streams SSE through without buffering and parses Anthropic usage', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    handler = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            model: 'claude-sonnet',
            usage: { input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 1 },
          },
        })}\n\n`,
      );
      gate.then(() => {
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } })}\n\n`,
        );
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 42 } })}\n\n`,
        );
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    };
    const t = proxy.createSession();
    const r = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': t, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet', stream: true }),
    });
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const reader = r.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    // First event arrives while the upstream is still holding the rest back.
    expect(first).toContain('message_start');
    release();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('message_stop');
    await new Promise((res) => setTimeout(res, 20));
    expect(usage).toEqual([
      { inputTokens: 25, outputTokens: 42, session: t, route: 'anthropic', model: 'claude-sonnet' },
    ]);
  });

  it('adds stream_options.include_usage for OpenAI chat streams and parses the usage chunk', async () => {
    handler = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    };
    const t = proxy.createSession();
    const r = await fetch(`${proxy.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-x', stream: true, messages: [] }),
    });
    await r.text();
    await new Promise((res) => setTimeout(res, 20));
    expect(JSON.parse(seen[0]!.body).stream_options).toEqual({ include_usage: true });
    expect(usage[0]).toMatchObject({ inputTokens: 11, outputTokens: 7, model: 'gpt-x', route: 'openai' });
  });

  it('parses non-streaming JSON usage incl. OpenRouter cost', async () => {
    handler = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ model: 'qwen/x', usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0.0012 } }),
      );
    };
    const t = proxy.createSession();
    const r = await fetch(`${proxy.url}/openrouter/api/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen/x', messages: [] }),
    });
    expect(await r.json()).toMatchObject({ usage: { cost: 0.0012 } });
    await new Promise((res) => setTimeout(res, 20));
    expect(usage[0]).toMatchObject({ inputTokens: 3, outputTokens: 4, costUsd: 0.0012, route: 'openrouter' });
  });

  it('denies with 429 when the budget is exhausted', async () => {
    budgetOk = false;
    const t = proxy.createSession();
    const r = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': t },
    });
    expect(r.status).toBe(429);
    expect(seen).toHaveLength(0);
  });

  it('404 unknown route, 400 traversal, 503 missing secret', async () => {
    const t = proxy.createSession();
    const h = { 'x-beamhop-session': t };
    expect((await fetch(`${proxy.url}/nope/v1`, { headers: h })).status).toBe(404);
    expect((await fetch(`${proxy.url}/anthropicx/v1`, { headers: h })).status).toBe(404);
    // Raw request: fetch would normalize the dot segments itself.
    const raw = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: proxy.port, path, headers: h }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    expect(await raw('/anthropic/v1/%2e%2e/admin')).toBe(400);
    expect(await raw('/anthropic/v1/../admin')).toBe(400);
    expect(await raw('//evil.example/x')).toBe(400);
    expect((await fetch(`${proxy.url}/nokey/v1`, { headers: h })).status).toBe(503);
    expect(seen).toHaveLength(0);
  });

  it('passes upstream error statuses through', async () => {
    handler = (res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"bad"}');
    };
    const t = proxy.createSession();
    const r = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': t },
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toBe('{"error":"bad"}');
  });

  it('502 when the upstream is unreachable', async () => {
    const dead = await createLlmProxy({
      secrets,
      routes: [
        {
          id: 'x',
          prefix: '/x',
          upstream: 'http://127.0.0.1:1',
          secretName: 'OPENAI_API_KEY',
          auth: 'bearer',
        },
      ],
    });
    try {
      const t = dead.createSession();
      const r = await fetch(`${dead.url}/x/v1`, { headers: { 'x-beamhop-session': t } });
      expect(r.status).toBe(502);
      expect(await r.text()).not.toContain(OPENAI_KEY);
    } finally {
      await dead.close();
    }
  });
});

describe('usage helpers', () => {
  it('parses OpenAI Responses API completion events', () => {
    const acc = {};
    const p = createSseParser((o) => foldUsage(acc, o));
    p.push('event: response.completed\r\ndata: {"type":"response.completed","response":{"model":"gpt-5",');
    p.push('"usage":{"input_tokens":9,"output_tokens":2}}}\r\n\r\n');
    p.end();
    expect(acc).toEqual({ input: 9, output: 2, model: 'gpt-5' });
  });
});

describe('envForHarness', () => {
  const url = 'http://127.0.0.1:5555';
  const ph = 'bh-sess-abc';
  it('claude', () => {
    const e = envForHarness('claude', url, ph);
    expect(e.ANTHROPIC_BASE_URL).toBe(`${url}/anthropic`);
    expect(e.ANTHROPIC_API_KEY).toBe(ph);
  });
  it('codex', () => {
    const e = envForHarness('codex', `${url}/`, ph);
    expect(e.OPENAI_BASE_URL).toBe(`${url}/openai/v1`);
    expect(e.OPENAI_API_KEY).toBe(ph);
  });
  it('opencode via OPENCODE_CONFIG_CONTENT', () => {
    const e = envForHarness('opencode', url, ph);
    const cfg = JSON.parse(e.OPENCODE_CONFIG_CONTENT!);
    expect(cfg.provider.openrouter.options.baseURL).toBe(`${url}/openrouter/api/v1`);
    expect(e.OPENROUTER_API_KEY).toBe(ph);
  });
  it('pi + models.json', () => {
    const e = envForHarness('pi', url, ph);
    expect(e.OPENROUTER_API_KEY).toBe(ph);
    expect(JSON.parse(piModelsJson(url)).providers.openrouter.baseUrl).toBe(`${url}/openrouter/api/v1`);
  });
  it('unknown harness gets every convention; no real keys ever', () => {
    const e = envForHarness('acp:foo', url, ph);
    expect(Object.values(e).every((v) => !v.startsWith('sk-'))).toBe(true);
    expect(e.OPENROUTER_BASE_URL).toBe(`${url}/openrouter/api/v1`);
  });
});
