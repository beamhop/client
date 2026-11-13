// Test-only fixtures for hosted mode: a fake relay (channel-nostr's test helper) + a fake daemon built on
// the real control server. Node environment only (the relay is a `ws` server).
import { type ControlServer, createControlServer, generateAgentKey } from '@beamhop/channel-nostr';
import { BeamhopError, type RpcRequest, type RpcResponse } from '@beamhop/core';
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { FakeRelay } from '../../../../../packages/channel-nostr/test/helpers/fake-relay.ts';
import type { NostrSigner } from '../signer.ts';

export { FakeRelay, sleep, waitFor } from '../../../../../packages/channel-nostr/test/helpers/fake-relay.ts';

export interface FakeDaemon {
  server: ControlServer;
  key: ReturnType<typeof generateAgentKey>;
  calls: { method: string; params: unknown; sender: string }[];
  /** Handlers by method; return a result or throw a BeamhopError. Missing = echo. */
  handlers: Record<string, (params: unknown, sender: string) => unknown>;
  /** Swallow these methods (simulate a daemon that never answers). */
  silent: Set<string>;
}

export const startFakeDaemon = async (
  relay: FakeRelay,
  opts: { allowlist?: string[]; publicMethods?: string[] } = {},
): Promise<FakeDaemon> => {
  const key = generateAgentKey();
  const calls: FakeDaemon['calls'] = [];
  const handlers: FakeDaemon['handlers'] = {};
  const silent = new Set<string>();
  const fd = { key, calls, handlers, silent } as FakeDaemon;
  fd.server = createControlServer({
    key: key.secretKey,
    allowlist: opts.allowlist ?? [],
    relays: [relay.url],
    publicMethods: opts.publicMethods ?? ['device.pairComplete'],
    publicRateLimit: { perSender: 1000, global: 1000, windowMs: 60_000 },
    handle: async (req: RpcRequest, ctx): Promise<RpcResponse> => {
      calls.push({ method: req.method, params: req.params, sender: ctx.sender });
      if (silent.has(req.method)) return new Promise(() => {}) as never;
      const h = handlers[req.method];
      try {
        const result = h ? await h(req.params, ctx.sender) : { echo: req.params, method: req.method };
        return { jsonrpc: '2.0', id: req.id, result };
      } catch (err) {
        const e = err as BeamhopError;
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32010, message: e.message, data: { code: e.code } },
        };
      }
    },
  });
  await fd.server.ready();
  return fd;
};

export const beamhopError = (code: ConstructorParameters<typeof BeamhopError>[0], msg: string) =>
  new BeamhopError(code, msg);

/** A NIP-07-like signer backed by a throwaway key (stands in for a browser extension). */
export const fakeExtensionSigner = (sk: Uint8Array): NostrSigner & { signed: number } => {
  const pk = getPublicKey(sk);
  const s = {
    signed: 0,
    getPublicKey: async () => pk,
    encrypt: async (peer: string, text: string) =>
      nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(sk, peer)),
    decrypt: async (peer: string, ct: string) =>
      nip44.v2.decrypt(ct, nip44.v2.utils.getConversationKey(sk, peer)),
    signEvent: async (ev: Parameters<NostrSigner['signEvent']>[0]) => {
      s.signed++;
      return finalizeEvent(ev, sk);
    },
  };
  return s;
};
