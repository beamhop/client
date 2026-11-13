import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, httpTransport, RpcError, wsTransport } from '@beamhop/client';
import { BeamhopError, silentLogger } from '@beamhop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiServer, startApiServer } from '../src/rpc-server.ts';

let api: ApiServer;
const token = 'test-token-123';
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bh-static-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>beamhop</title>');
  api = await startApiServer({
    token,
    log: silentLogger,
    staticDir: dir,
    handlers: {
      'system.resume': async () => ({ ok: true }),
      'agent.get': async ({ name }) => {
        throw new BeamhopError('not_found', `agent ${name} not found`);
      },
      'session.send': async () => {
        throw new Error('kaboom');
      },
    },
  });
});
afterAll(() => api.close());

describe('api server', () => {
  it('rejects missing token', async () => {
    const c = createClient(httpTransport(api.url, 'nope'));
    await expect(c.call('system.resume')).rejects.toThrow(/Unauthorized/);
  });
  it('dispatches over http', async () => {
    const c = createClient(httpTransport(api.url, token));
    await expect(c.call('system.resume')).resolves.toEqual({ ok: true });
  });
  it('maps BeamhopError codes', async () => {
    const c = createClient(httpTransport(api.url, token));
    const err = await c.call('agent.get', { name: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).beamhopCode).toBe('not_found');
  });
  it('validates params against the contract', async () => {
    const c = createClient(httpTransport(api.url, token));
    const err = await c.call('agent.get', {} as never).catch((e) => e);
    expect((err as RpcError).code).toBe(-32602);
  });
  it('hides internal errors', async () => {
    const c = createClient(httpTransport(api.url, token));
    const err = await c.call('session.send', { id: 'a', text: 'b' }).catch((e) => e);
    expect((err as RpcError).message).toBe('Internal error');
  });
  it('reports unimplemented methods', async () => {
    const c = createClient(httpTransport(api.url, token));
    const err = await c.call('agent.list').catch((e) => e);
    expect((err as RpcError).code).toBe(-32601);
  });
  it('works over websocket and pushes events', async () => {
    const t = wsTransport(api.url, token, { reconnect: false });
    const c = createClient(t);
    const got: unknown[] = [];
    c.on((e) => got.push(e));
    await expect(c.call('system.resume')).resolves.toEqual({ ok: true });
    api.broadcast({ type: 'panic', active: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([{ type: 'panic', active: true }]);
    c.close();
  });
  it('serves the PWA with SPA fallback and blocks traversal', async () => {
    const r1 = await fetch(`${api.url}/inbox`);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const r2 = await fetch(`${api.url}/..%2f..%2fetc%2fpasswd`);
    expect(r2.status).toBe(404);
  });
});
