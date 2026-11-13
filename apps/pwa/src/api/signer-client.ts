/**
 * Control-plane client (§4 wire format: kind 25910, NIP-44, `e`-tagged replies, `m` chunks) for keys the
 * PWA cannot hold: NIP-07 extensions and (later) NIP-46 bunkers. Same `ControlClient` surface as
 * `createControlClient` from `@beamhop/channel-nostr`, which handles device keys; this variant asks the
 * signer to sign / encrypt / decrypt instead of using a raw secret key.
 */

import {
  CONTROL_KIND,
  ControlRpcError,
  MAX_CHUNKS,
  newRpcId,
  REPLAY_WINDOW_S,
  type RelayPool,
  ReplayGuard,
  splitChunks,
  tagValue,
} from '@beamhop/channel-nostr';
import type { ControlClient } from '@beamhop/channel-nostr/control-client';
import type { RpcNotification, RpcResponse, ServerEvent } from '@beamhop/core';
import type { Event } from 'nostr-tools/core';
import type { NostrSigner } from './signer.ts';

export interface SignerControlClientOptions {
  signer: NostrSigner;
  /** The signer's pubkey (hex), already fetched. */
  pubkey: string;
  /** Daemon pubkey (hex). */
  daemonPubkey: string;
  relays: string[];
  pool: RelayPool;
  timeoutMs?: number;
}

const MAX_CIPHERTEXT = 100_000;

interface Pending {
  rpcId: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const createSignerControlClient = (o: SignerControlClientOptions): ControlClient => {
  const { signer, pubkey, daemonPubkey: daemon, pool } = o;
  const relays = o.relays.map((r) => pool.addRelay(r));
  const guard = new ReplayGuard();
  const pending = new Map<string, Pending>();
  const handlers = new Set<(ev: ServerEvent) => void>();
  const chunks = new Map<string, { parts: (string | undefined)[]; got: number }>();
  let closed = false;

  let readyResolve!: () => void;
  const readyP = new Promise<void>((r) => {
    readyResolve = r;
  });

  const assemble = (ev: Event, text: string): string | undefined => {
    const m = ev.tags.find((t) => t[0] === 'm');
    if (!m) return text;
    const [, msgId, idxS, totalS] = m;
    const idx = Number(idxS);
    const total = Number(totalS);
    if (!msgId || !Number.isInteger(idx) || !Number.isInteger(total) || total < 1 || total > MAX_CHUNKS)
      return undefined;
    if (idx < 0 || idx >= total) return undefined;
    const key = `${msgId}:${tagValue(ev.tags, 'e') ?? ''}`;
    let p = chunks.get(key);
    if (!p) {
      if (chunks.size > 64) chunks.delete(chunks.keys().next().value as string);
      p = { parts: new Array(total).fill(undefined), got: 0 };
      chunks.set(key, p);
    }
    if (p.parts.length !== total) return undefined;
    if (p.parts[idx] === undefined) {
      p.parts[idx] = text;
      p.got++;
    }
    if (p.got < total) return undefined;
    chunks.delete(key);
    return p.parts.join('');
  };

  const dispatch = (ev: Event, text: string) => {
    let msg: RpcResponse | RpcNotification;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || (msg as { jsonrpc?: string }).jsonrpc !== '2.0') return;
    if ('method' in msg && msg.method === 'event') {
      for (const h of handlers) {
        try {
          h(msg.params);
        } catch {
          // a listener's bug must not break the client
        }
      }
      return;
    }
    const reqId = tagValue(ev.tags, 'e');
    const p = reqId ? pending.get(reqId) : undefined;
    if (!reqId || !p || !('id' in msg) || msg.id !== p.rpcId) return;
    pending.delete(reqId);
    clearTimeout(p.timer);
    if ('error' in msg && msg.error)
      p.reject(new ControlRpcError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve((msg as { result?: unknown }).result);
  };

  const onevent = (ev: Event) => {
    if (closed || ev.kind !== CONTROL_KIND || ev.pubkey !== daemon) return;
    if (tagValue(ev.tags, 'p') !== pubkey) return;
    if (guard.check(ev)) return;
    if (ev.content.length > MAX_CIPHERTEXT) return;
    signer.decrypt(daemon, ev.content).then(
      (plain) => {
        const text = assemble(ev, plain);
        if (text !== undefined) dispatch(ev, text);
      },
      () => {
        /* undecryptable: ignore */
      },
    );
  };

  const sub = pool.subscribe(
    [
      {
        kinds: [CONTROL_KIND],
        authors: [daemon],
        '#p': [pubkey],
        since: Math.floor(Date.now() / 1000) - REPLAY_WINDOW_S,
      },
    ],
    { onevent, oneose: () => readyResolve() },
    { relays },
  );
  setTimeout(() => readyResolve(), 5000);

  const buildEvents = async (payload: unknown) => {
    const parts = splitChunks(JSON.stringify(payload));
    if (parts.length > MAX_CHUNKS) throw new ControlRpcError(-32600, 'control request too large');
    const msgId = parts.length > 1 ? newRpcId().slice(0, 16) : undefined;
    const created_at = Math.floor(Date.now() / 1000);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const tags: string[][] = [['p', daemon]];
      if (msgId) tags.push(['m', msgId, String(i), String(parts.length)]);
      const content = await signer.encrypt(daemon, parts[i]!);
      out.push(await signer.signEvent({ kind: CONTROL_KIND, created_at, tags, content }));
    }
    return out;
  };

  return {
    pubkey,
    daemonPubkey: daemon,
    ready: () => readyP,
    async call<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
      if (closed) throw new ControlRpcError(-32003, 'control client closed');
      const rpcId = newRpcId();
      const events = await buildEvents({
        jsonrpc: '2.0',
        id: rpcId,
        method,
        ...(params === undefined ? {} : { params }),
      });
      const reqEventId = events[0]!.id;
      const result = new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            pending.delete(reqEventId);
            reject(new ControlRpcError(-32001, `control call ${method} timed out`));
          },
          timeoutMs ?? o.timeoutMs ?? 15_000,
        );
        pending.set(reqEventId, { rpcId, resolve: resolve as (v: unknown) => void, reject, timer });
      });
      const pubs = await Promise.all(events.map((e) => pool.publish(e, { relays, quorum: 1 })));
      if (pubs.some((p) => p.ok.length === 0)) {
        const p = pending.get(reqEventId);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(reqEventId);
          p.reject(new ControlRpcError(-32002, 'could not reach any relay'));
        }
      }
      return result;
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      sub.close();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new ControlRpcError(-32003, 'control client closed'));
      }
      pending.clear();
    },
  };
};
