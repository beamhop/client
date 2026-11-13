import { createServer, type Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { silentLogger } from '@beamhop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridgeClient, createMcpBridge, envProxyFetch, type McpBridge } from '../src/index.ts';
import { type Calls, defaultCtx, type FakeCtx, fakeHandlers } from './helpers.ts';

/** A minimal CONNECT proxy that records its targets (stands in for srt's HTTP proxy). */
const connectProxy = async (): Promise<{ server: Server; url: string; targets: string[] }> => {
  const targets: string[] = [];
  const server = createServer((_req, res) => res.writeHead(405).end());
  server.on('connect', (req, socket, head) => {
    targets.push(req.url ?? '');
    const [host, port] = (req.url ?? '').split(':');
    const up = connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(socket).pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, targets };
};

let bridge: McpBridge<FakeCtx> | undefined;
let proxy: Server | undefined;
afterEach(async () => {
  await bridge?.close();
  proxy?.close();
  bridge = undefined;
  proxy = undefined;
});

describe('envProxyFetch (sandbox proxy env)', () => {
  it('is undefined without a proxy configured', async () => {
    expect(await envProxyFetch({})).toBeUndefined();
  });

  it('tunnels the bridge call through HTTP_PROXY when 127.0.0.1 is not in NO_PROXY (macOS layout)', async () => {
    const calls: Calls = [];
    bridge = await createMcpBridge({ handlers: fakeHandlers(calls), log: silentLogger });
    const p = await connectProxy();
    proxy = p.server;
    const f = await envProxyFetch({ HTTP_PROXY: p.url, NO_PROXY: 'localhost,::1' });
    expect(f).toBeDefined();
    const call = createBridgeClient({ url: bridge.url, token: bridge.addSession(defaultCtx()), fetch: f! });
    const r = await call('session_status', {});
    expect(r.ok).toBe(true);
    expect(p.targets).toEqual([`127.0.0.1:${bridge.port}`]);
  });

  it('goes direct when NO_PROXY lists 127.0.0.1 (Linux layout: in-sandbox forwarder)', async () => {
    const calls: Calls = [];
    bridge = await createMcpBridge({ handlers: fakeHandlers(calls), log: silentLogger });
    const p = await connectProxy();
    proxy = p.server;
    const f = await envProxyFetch({
      HTTP_PROXY: p.url,
      HTTPS_PROXY: p.url,
      NO_PROXY: 'localhost,127.0.0.1,::1',
    });
    const call = createBridgeClient({ url: bridge.url, token: bridge.addSession(defaultCtx()), fetch: f! });
    expect((await call('session_status', {})).ok).toBe(true);
    expect(p.targets).toEqual([]);
  });
});
