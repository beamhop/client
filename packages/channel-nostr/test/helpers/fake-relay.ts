// Tiny in-process NIP-01 relay for unit tests (with optional NIP-42 auth).
import type { AddressInfo } from 'node:net';
import type { Event } from 'nostr-tools/core';
import { type Filter, matchFilters } from 'nostr-tools/filter';
import { verifyEvent } from 'nostr-tools/pure';
import { type WebSocket, WebSocketServer } from 'ws';

interface Client {
  ws: WebSocket;
  subs: Map<string, Filter[]>;
  challenge: string;
  authed: Set<string>;
}

export interface FakeRelayOptions {
  /** Require NIP-42 auth for writes. */
  authForWrites?: boolean;
}

export class FakeRelay {
  readonly events: Event[] = [];
  readonly received: Event[] = [];
  private clients = new Set<Client>();
  private wss!: WebSocketServer;
  url = '';
  port = 0;

  constructor(readonly opts: FakeRelayOptions = {}) {}

  async start(port = 0): Promise<this> {
    this.wss = new WebSocketServer({ port, host: '127.0.0.1' });
    await new Promise<void>((r) => this.wss.once('listening', () => r()));
    this.port = (this.wss.address() as AddressInfo).port;
    this.url = `ws://127.0.0.1:${this.port}`;
    this.wss.on('connection', (ws) => this.onConnection(ws));
    return this;
  }

  private onConnection(ws: WebSocket): void {
    const c: Client = {
      ws,
      subs: new Map(),
      challenge: Math.random().toString(36).slice(2),
      authed: new Set(),
    };
    this.clients.add(c);
    ws.on('close', () => this.clients.delete(c));
    if (this.opts.authForWrites) ws.send(JSON.stringify(['AUTH', c.challenge]));
    ws.on('message', (data) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(String(data));
      } catch {
        ws.send(JSON.stringify(['NOTICE', 'invalid json']));
        return;
      }
      const [type, ...rest] = msg as [string, ...unknown[]];
      if (type === 'EVENT') this.onEvent(c, rest[0] as Event);
      else if (type === 'REQ') {
        const [id, ...filters] = rest as [string, ...Filter[]];
        c.subs.set(id, filters);
        const matching = this.events
          .filter((e) => matchFilters(filters, e))
          .sort((a, b) => b.created_at - a.created_at);
        const limit = Math.min(...filters.map((f) => f.limit ?? Number.POSITIVE_INFINITY));
        for (const e of matching.slice(0, Number.isFinite(limit) ? limit : undefined))
          ws.send(JSON.stringify(['EVENT', id, e]));
        ws.send(JSON.stringify(['EOSE', id]));
      } else if (type === 'CLOSE') c.subs.delete(rest[0] as string);
      else if (type === 'AUTH') {
        const ev = rest[0] as Event;
        const ok =
          verifyEvent(ev) &&
          ev.kind === 22242 &&
          ev.tags.some((t) => t[0] === 'challenge' && t[1] === c.challenge);
        if (ok) c.authed.add(ev.pubkey);
        ws.send(JSON.stringify(['OK', ev.id, ok, ok ? '' : 'auth failed']));
      }
    });
  }

  private onEvent(c: Client, ev: Event): void {
    const send = (ok: boolean, reason = ''): void => c.ws.send(JSON.stringify(['OK', ev.id, ok, reason]));
    if (!verifyEvent({ ...ev })) {
      send(false, 'invalid: bad signature');
      return;
    }
    if (this.opts.authForWrites && !c.authed.has(ev.pubkey)) {
      send(false, 'auth-required: please auth');
      return;
    }
    this.received.push(ev);
    if (this.events.some((e) => e.id === ev.id)) {
      send(true, 'duplicate: already have it');
      return;
    }
    const ephemeral = ev.kind >= 20000 && ev.kind < 30000;
    if (!ephemeral) this.events.push(ev);
    send(true);
    this.broadcast(ev);
  }

  /** Inject an event as if another client published it (bypasses auth). */
  inject(ev: Event, store = true): void {
    if (store && !(ev.kind >= 20000 && ev.kind < 30000)) this.events.push(ev);
    this.broadcast(ev);
  }

  private broadcast(ev: Event): void {
    for (const cl of this.clients) {
      for (const [id, filters] of cl.subs) {
        if (matchFilters(filters, ev)) cl.ws.send(JSON.stringify(['EVENT', id, ev]));
      }
    }
  }

  get connections(): number {
    return this.clients.size;
  }

  get subscriptions(): number {
    let n = 0;
    for (const c of this.clients) n += c.subs.size;
    return n;
  }

  /** Forget stored events (test isolation). */
  reset(): void {
    this.events.length = 0;
    this.received.length = 0;
  }

  /** Drop all client connections (simulates a relay restart). */
  dropAll(): void {
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
  }

  async stop(): Promise<void> {
    this.dropAll();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

export const waitFor = async <T>(
  fn: () => T | undefined | false,
  timeoutMs = 5000,
  stepMs = 20,
): Promise<T> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timed out');
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
