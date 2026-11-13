// docs/security/REVIEW-wave-a.md — API-1..3: browser-originated / DNS-rebinding requests are refused.
import { request } from 'node:http';
import { silentLogger } from '@beamhop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type ApiServer, startApiServer } from '../src/rpc-server.ts';

let api: ApiServer;
let port = 0;
const token = 'origin-test-token';
const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system.resume' });

const post = (headers: Record<string, string>, path = '/rpc'): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });

const wsOpen = (headers: Record<string, string>, origin?: string): Promise<'open' | number> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, {
      headers,
      ...(origin ? { origin } : {}),
    });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(0));
  });

const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

beforeAll(async () => {
  api = await startApiServer({
    token,
    log: silentLogger,
    handlers: { 'system.resume': async () => ({ ok: true }) },
    allowedHosts: ['beamhop.tailnet.example:8443'],
  });
  port = Number(new URL(api.url).port);
});
afterAll(() => api.close());

describe('api server origin / host policy', () => {
  it('accepts same-origin and non-browser (no Origin) requests', async () => {
    expect(await post(auth)).toBe(200);
    expect(await post({ ...auth, origin: `http://127.0.0.1:${port}` })).toBe(200);
    expect(await post({ ...auth, origin: `http://localhost:${port}`, host: `localhost:${port}` })).toBe(200);
    expect(
      await post({
        ...auth,
        host: 'beamhop.tailnet.example:8443',
        origin: 'https://beamhop.tailnet.example:8443',
      }),
    ).toBe(200);
  });

  it('API-1: rejects cross-origin POSTs even with a valid token', async () => {
    expect(await post({ ...auth, origin: 'https://evil.example' })).toBe(403);
    expect(await post({ ...auth, origin: 'null' })).toBe(403);
    expect(await post({ ...auth, 'sec-fetch-site': 'cross-site' })).toBe(403);
  });

  it('API-2: rejects foreign Host headers (DNS rebinding)', async () => {
    expect(await post({ ...auth, host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).toBe(
      403,
    );
    expect(await post({ ...auth, host: `evil.example:${port}` })).toBe(403);
  });

  it('API-1: requires application/json (no CORS-safelisted text/plain simple requests)', async () => {
    expect(await post({ authorization: `Bearer ${token}`, 'content-type': 'text/plain' })).toBe(415);
  });

  it('API-3: refuses cross-site WebSocket upgrades, allows same-origin ones', async () => {
    expect(await wsOpen({})).toBe('open');
    expect(await wsOpen({}, `http://127.0.0.1:${port}`)).toBe('open');
    expect(await wsOpen({}, 'https://evil.example')).toBe(403);
    expect(await wsOpen({ host: `evil.example:${port}` })).toBe(403);
  });
});
