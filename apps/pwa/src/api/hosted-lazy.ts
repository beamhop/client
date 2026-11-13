/**
 * Hosted mode is code-split: the Nostr stack (nostr-tools, NIP-44, relay pool) only loads when the app
 * boots into a saved daemon. This wrapper is a Transport right away and forwards to the real one.
 */
import type { Transport } from '@beamhop/client';
import type { ServerEvent } from '@beamhop/core';
import type { HostedIdentity } from './identity.ts';
import type { NostrTransport, NostrTransportOptions } from './nostr.ts';
import type { SignerKind } from './signer.ts';

export type LazyNostrOptions = Omit<NostrTransportOptions, 'identity'> & {
  identity?: HostedIdentity | (() => Promise<HostedIdentity>);
  signer: SignerKind;
};

export const lazyNostrTransport = (
  opts: LazyNostrOptions,
  onLoaded: (t: NostrTransport) => void,
  onError: (err: unknown) => void,
): Transport => {
  let real: NostrTransport | undefined;
  let closed = false;
  const subs = new Map<(e: ServerEvent) => void, { off?: () => void }>();
  const ready = (async () => {
    const [{ nostrTransport }, { resolveIdentity }] = await Promise.all([
      import('./nostr.ts'),
      import('./identity.ts'),
    ]);
    const { signer, identity, ...rest } = opts;
    const t = nostrTransport({ ...rest, identity: identity ?? (() => resolveIdentity(signer)) });
    if (closed) t.close();
    real = t;
    for (const [fn, box] of subs) box.off = t.subscribe(fn);
    onLoaded(t);
    return t;
  })();
  ready.catch(onError);
  return {
    request: (method, params) => ready.then((t) => t.request(method, params)),
    subscribe(fn) {
      const box: { off?: () => void } = {};
      subs.set(fn, box);
      if (real) box.off = real.subscribe(fn);
      return () => {
        subs.delete(fn);
        box.off?.();
      };
    },
    close() {
      closed = true;
      real?.close();
    },
  };
};
