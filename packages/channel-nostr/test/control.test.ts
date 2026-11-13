import { BeamhopError, type RpcRequest, type ServerEvent } from '@beamhop/core';
import { finalizeEvent } from 'nostr-tools/pure';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ControlRpcError, createControlClient } from '../src/control-client.ts';
import {
  buildControlEvents,
  CONTROL_KIND,
  ControlDecoder,
  ReplayGuard,
  splitChunks,
} from '../src/control-protocol.ts';
import { type ControlServer, createControlServer } from '../src/control-server.ts';
import { generateAgentKey } from '../src/keys.ts';
import { FakeRelay, sleep, waitFor } from './helpers/fake-relay.ts';

let R: FakeRelay;
const daemon = generateAgentKey();
const phone = generateAgentKey();
const stranger = generateAgentKey();
const closers: { close(): void }[] = [];

beforeAll(async () => {
  R = await new FakeRelay().start();
});
afterAll(() => R.stop());
afterEach(async () => {
  for (const c of closers.splice(0)) c.close();
  await sleep(20);
  R.reset();
});

const calls: { req: RpcRequest; sender: string }[] = [];
const startServer = async (allowlist = [phone.npub]): Promise<ControlServer> => {
  calls.length = 0;
  const server = createControlServer({
    key: daemon.nsec,
    allowlist,
    relays: [R.url],
    handle: async (req, ctx) => {
      calls.push({ req, sender: ctx.sender });
      if (req.method === 'boom') throw new BeamhopError('forbidden', 'not allowed');
      if (req.method === 'crash') throw new Error('secret internal detail');
      if (req.method === 'big') return { jsonrpc: '2.0', id: req.id, result: { blob: 'x'.repeat(70_000) } };
      return { jsonrpc: '2.0', id: req.id, result: { echo: req.params, method: req.method } };
    },
  });
  closers.push(server);
  await server.ready();
  return server;
};

const client = async (key = phone) => {
  const c = createControlClient({
    key: key.secretKey,
    daemonPubkey: daemon.npub,
    relays: [R.url],
    timeoutMs: 1500,
  });
  closers.push(c);
  await c.ready();
  return c;
};

describe('control plane over nostr', () => {
  it('round-trips an encrypted JSON-RPC call', async () => {
    await startServer();
    const c = await client();
    const res = await c.call<{ echo: unknown; method: string }>('agents.list', { a: 1 });
    expect(res).toEqual({ echo: { a: 1 }, method: 'agents.list' });
    expect(calls[0]!.sender).toBe(phone.pubkey);
    // On the wire everything is ciphertext, p-tagged, and replies reference the request.
    const wire = R.received.filter((e) => e.kind === CONTROL_KIND);
    expect(wire).toHaveLength(2);
    expect(wire.some((e) => e.content.includes('agents.list'))).toBe(false);
    expect(wire[1]!.tags).toContainEqual(['e', wire[0]!.id]);
    expect(wire[1]!.tags).toContainEqual(['p', phone.pubkey]);
  });

  it('maps handler errors to JSON-RPC errors without leaking internals', async () => {
    await startServer();
    const c = await client();
    const e1 = await c.call('boom').catch((e) => e);
    expect(e1).toBeInstanceOf(ControlRpcError);
    expect(e1).toMatchObject({ code: -32000, message: 'not allowed', data: { code: 'forbidden' } });
    const e2 = await c.call('crash').catch((e) => e);
    expect(e2).toMatchObject({ code: -32603, message: 'internal error' });
  });

  it('ignores senders that are not on the allowlist', async () => {
    await startServer();
    const c = await client(stranger);
    const err = await c.call('agents.list', undefined, 600).catch((e) => e);
    expect(err).toMatchObject({ code: -32001 });
    expect(calls).toHaveLength(0);
    expect(R.received.filter((e) => e.pubkey === daemon.pubkey)).toHaveLength(0);
  });

  it('honours allowlist updates (device removal)', async () => {
    const server = await startServer();
    const c = await client();
    await c.call('ping');
    server.setAllowlist([]);
    const err = (await c.call('ping', undefined, 600).catch((e) => e)) as ControlRpcError;
    expect(err.code).toBe(-32001);
    expect(calls).toHaveLength(1);
  });

  it('rejects replayed and stale request events', async () => {
    await startServer();
    const c = await client();
    await c.call('first');
    const req = R.received.find((e) => e.pubkey === phone.pubkey)!;
    R.inject(req, false); // replay the exact event
    await sleep(150);
    expect(calls).toHaveLength(1);
    // Fresh id but created_at outside the ±120 s window
    const [stale] = buildControlEvents(
      phone.secretKey,
      daemon.pubkey,
      { jsonrpc: '2.0', id: 1, method: 'stale' },
      { createdAt: Math.floor(Date.now() / 1000) - 600 },
    );
    R.inject(stale!, false);
    const [future] = buildControlEvents(
      phone.secretKey,
      daemon.pubkey,
      { jsonrpc: '2.0', id: 2, method: 'future' },
      { createdAt: Math.floor(Date.now() / 1000) + 600 },
    );
    R.inject(future!, false);
    await sleep(150);
    expect(calls.map((x) => x.req.method)).toEqual(['first']);
  });

  it('rejects malformed requests and payloads not encrypted to the daemon', async () => {
    await startServer();
    await client();
    // Valid sender, but garbage ciphertext
    R.inject(
      finalizeEvent(
        {
          kind: CONTROL_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', daemon.pubkey]],
          content: 'AAAA',
        },
        phone.secretKey,
      ),
      false,
    );
    // Valid encryption but not a JSON-RPC request
    const [bad] = buildControlEvents(phone.secretKey, daemon.pubkey, { hello: 'world' });
    R.inject(bad!, false);
    await waitFor(() => R.received.some((e) => e.pubkey === daemon.pubkey));
    const reply = R.received.find((e) => e.pubkey === daemon.pubkey)!;
    const text = new ControlDecoder(phone.secretKey).decode(reply)!;
    expect(JSON.parse(text).error.code).toBe(-32600);
    expect(calls).toHaveLength(0);
  });

  it('never answers JSON-RPC responses or notifications (no reply ping-pong)', async () => {
    await startServer();
    await client();
    for (const payload of [
      { jsonrpc: '2.0', id: 'x', result: { ok: true } },
      { jsonrpc: '2.0', id: 'y', error: { code: -32600, message: 'invalid request' } },
      { jsonrpc: '2.0', method: 'event', params: { type: 'panic', active: true } },
    ])
      R.inject(buildControlEvents(phone.secretKey, daemon.pubkey, payload)[0]!, false);
    // A real request afterwards still gets its (only) reply.
    R.inject(
      buildControlEvents(phone.secretKey, daemon.pubkey, { jsonrpc: '2.0', id: 1, method: 'ping' })[0]!,
      false,
    );
    await waitFor(() => calls.length === 1);
    await sleep(100);
    expect(R.received.filter((e) => e.pubkey === daemon.pubkey)).toHaveLength(1);
  });

  it('pushes server events to allowlisted clients', async () => {
    const server = await startServer();
    const c = await client();
    const got: ServerEvent[] = [];
    c.onEvent((e) => got.push(e));
    await server.notify({ type: 'panic', active: true });
    await waitFor(() => got.length);
    expect(got[0]).toEqual({ type: 'panic', active: true });
    // notify() never sends to keys outside the allowlist
    await server.notify({ type: 'panic', active: false }, [stranger.npub]);
    await sleep(100);
    expect(
      R.received.filter((e) => e.tags.some((t) => t[0] === 'p' && t[1] === stranger.pubkey)),
    ).toHaveLength(0);
  });

  it('chunks payloads larger than one NIP-44 frame', async () => {
    await startServer();
    const c = await client();
    const res = await c.call<{ blob: string }>('big', { pad: 'y'.repeat(50_000) });
    expect(res.blob).toHaveLength(70_000);
    expect(calls[0]!.req.params).toEqual({ pad: 'y'.repeat(50_000) });
    const chunks = R.received.filter((e) => e.tags.some((t) => t[0] === 'm'));
    expect(chunks.length).toBeGreaterThanOrEqual(6);
  });

  it('protocol helpers', () => {
    const g = new ReplayGuard(10, 120, () => 1000);
    expect(g.check({ id: 'a', created_at: 1000 })).toBeUndefined();
    expect(g.check({ id: 'a', created_at: 1000 })).toBe('replay');
    expect(g.check({ id: 'b', created_at: 800 })).toBe('stale');
    expect(g.check({ id: 'c', created_at: 1121 })).toBe('stale');
    const s = `${'a'.repeat(19_999)}😀b`;
    const parts = splitChunks(s);
    expect(parts.join('')).toBe(s);
    expect(parts[0]!.length).toBe(19_999);
  });
});
