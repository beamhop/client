/**
 * Mesh (§6A.6) over Nostr: mesh_ask_agent = NIP-17 DM with a `hops` tag and a bounded wait for the
 * peer's reply; mesh_list_agents = NIP-89 capability cards; mesh_post_job / mesh_job_result = NIP-90.
 * The provider uses whichever nostr channel is connected.
 */
import { BeamhopError, type ChannelConn, type InboundMsg } from '@beamhop/core';
import type { Daemon } from './daemon.ts';

export interface MeshProvider {
  listAgents(query?: string): Promise<unknown[]>;
  ask(input: {
    npub: string;
    question: string;
    hops: number;
    timeoutSeconds: number;
    signal: AbortSignal;
  }): Promise<string>;
  postJob(input: {
    kind: number;
    input: string;
    inputType: string;
    peer?: string;
    hops: number;
  }): Promise<{ jobId: string }>;
  jobResult(input: { jobId: string; waitSeconds: number; signal: AbortSignal }): Promise<unknown>;
  /** Return true when the inbound message answers a pending ask (it is then not routed further). */
  onInbound?(conn: ChannelConn, msg: InboundMsg): boolean;
  subscribe?(filter: unknown, onEvent: (ev: unknown) => void): () => void;
  /**
   * Is this principal a known peer agent (published capability card or a valid owner attestation)?
   * Used when a Nostr peer drops the `hops` tag (review wave B R-B1). Must be cheap (cached).
   */
  isKnownAgent?(principal: string): Promise<boolean>;
}

interface NostrLike extends ChannelConn {
  pool: {
    query(
      filters: unknown[],
      opts?: { timeoutMs?: number },
    ): Promise<
      { id: string; pubkey: string; kind: number; tags: string[][]; content: string; created_at: number }[]
    >;
    subscribe(filters: unknown[], h: { onevent?: (ev: unknown) => void }): { close(): void };
  };
  publish(t: {
    kind: number;
    tags: string[][];
    content: string;
    created_at: number;
  }): Promise<{ id: string; ok: string[] }>;
}

type NostrMod = {
  parseCapabilityCard: (
    ev: never,
  ) => { agent: string; owner?: string; jobKinds: number[]; name?: string; capabilities: string[] } | null;
  decodePubkey: (k: string) => string;
  npubEncode: (hex: string) => string;
  CAPABILITY_CARD_KIND: number;
  ATTESTATION_KIND: number;
  verifyAttestation: (ev: never, expect?: { agentPubkey?: string }) => { ok: boolean };
};

const KNOWN_TTL_MS = 10 * 60_000;
const KNOWN_MAX = 2000;

export class NostrMesh implements MeshProvider {
  private readonly asks = new Map<string, { resolve: (t: string) => void }[]>();
  private readonly known = new Map<string, { value: boolean; at: number; pending?: Promise<boolean> }>();

  constructor(
    private readonly d: Daemon,
    private readonly mod: NostrMod,
  ) {}

  private conn(): NostrLike {
    const c = this.d.channels.connected().find((x) => x.provider === 'nostr') as NostrLike | undefined;
    if (!c) throw new BeamhopError('unavailable', 'mesh tools need a connected nostr channel');
    return c;
  }

  async listAgents(query?: string): Promise<unknown[]> {
    const c = this.conn();
    const evs = await c.pool.query(
      [{ kinds: [this.mod.CAPABILITY_CARD_KIND], '#t': ['beamhop'], limit: 100 }],
      { timeoutMs: 8000 },
    );
    const q = query?.toLowerCase();
    return evs
      .map((e) => this.mod.parseCapabilityCard(e as never))
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map((x) => ({ ...x, npub: this.mod.npubEncode(x.agent) }))
      .filter((x) => !q || JSON.stringify(x).toLowerCase().includes(q))
      .slice(0, 50);
  }

  async ask(input: {
    npub: string;
    question: string;
    hops: number;
    timeoutSeconds: number;
    signal: AbortSignal;
  }): Promise<string> {
    const c = this.conn();
    const principal = `nostr:${input.npub}`.toLowerCase();
    const reply = new Promise<string>((resolve, reject) => {
      const list = this.asks.get(principal) ?? [];
      const entry: { resolve: (t: string) => void } = { resolve: (t: string) => resolve(t) };
      list.push(entry);
      this.asks.set(principal, list);
      const t = setTimeout(() => {
        cleanup();
        reject(new BeamhopError('timeout', `no reply from ${input.npub} within ${input.timeoutSeconds}s`));
      }, input.timeoutSeconds * 1000);
      const cleanup = () => {
        clearTimeout(t);
        const l = this.asks.get(principal) ?? [];
        const i = l.indexOf(entry);
        if (i >= 0) l.splice(i, 1);
      };
      input.signal.addEventListener('abort', () => {
        cleanup();
        reject(new BeamhopError('unavailable', 'cancelled'));
      });
      entry.resolve = (text: string) => {
        cleanup();
        resolve(text);
      };
    });
    await c.send({
      conversation: { kind: 'dm', id: input.npub },
      markdown: input.question,
      hops: input.hops,
    });
    return reply;
  }

  onInbound(conn: ChannelConn, msg: InboundMsg): boolean {
    if (conn.provider !== 'nostr' || msg.conversation.kind !== 'dm') return false;
    const list = this.asks.get(msg.from.principal.toLowerCase());
    const w = list?.shift();
    if (!w) return false;
    w.resolve(msg.text);
    return true;
  }

  async postJob(input: {
    kind: number;
    input: string;
    inputType: string;
    peer?: string;
    hops: number;
  }): Promise<{ jobId: string }> {
    const c = this.conn();
    const tags: string[][] = [
      ['i', input.input, input.inputType],
      ['hops', String(input.hops)],
      ['t', 'beamhop'],
    ];
    if (input.peer) tags.push(['p', this.mod.decodePubkey(input.peer)]);
    const r = await c.publish({
      kind: input.kind,
      tags,
      content: '',
      created_at: Math.floor(Date.now() / 1000),
    });
    if (!r.ok.length) throw new BeamhopError('unavailable', 'job could not be published to any relay');
    return { jobId: r.id };
  }

  async jobResult(input: { jobId: string; waitSeconds: number; signal: AbortSignal }): Promise<unknown> {
    const c = this.conn();
    const filter = {
      kinds: Array.from({ length: 1000 }, (_, i) => 6000 + i).concat([7000]),
      '#e': [input.jobId],
    };
    const found = await c.pool.query([filter], { timeoutMs: 6000 });
    const result = found.find((e) => e.kind >= 6000 && e.kind < 7000);
    if (result || input.waitSeconds === 0)
      return result
        ? { status: 'success', content: result.content, from: this.mod.npubEncode(result.pubkey) }
        : { status: 'pending', feedback: found.map((e) => e.content) };
    return new Promise((resolve) => {
      const sub = c.pool.subscribe([filter], {
        onevent: (ev) => {
          const e = ev as { kind: number; content: string; pubkey: string };
          if (e.kind >= 6000 && e.kind < 7000) {
            clearTimeout(t);
            sub.close();
            resolve({ status: 'success', content: e.content, from: this.mod.npubEncode(e.pubkey) });
          }
        },
      });
      const t = setTimeout(() => {
        sub.close();
        resolve({ status: 'pending' });
      }, input.waitSeconds * 1000);
      input.signal.addEventListener('abort', () => {
        clearTimeout(t);
        sub.close();
        resolve({ status: 'cancelled' });
      });
    });
  }

  async isKnownAgent(principal: string): Promise<boolean> {
    if (!principal.startsWith('nostr:')) return false;
    let hex: string;
    try {
      hex = this.mod.decodePubkey(principal.slice(6));
    } catch {
      return false;
    }
    const now = Date.now();
    const hit = this.known.get(hex);
    if (hit?.pending) return hit.pending;
    if (hit && now - hit.at < KNOWN_TTL_MS) return hit.value;
    let c: NostrLike;
    try {
      c = this.conn();
    } catch {
      return false;
    }
    const pending = c.pool
      .query(
        [
          { kinds: [this.mod.CAPABILITY_CARD_KIND], authors: [hex], limit: 5 },
          { kinds: [this.mod.ATTESTATION_KIND], '#d': [`beamhop-agent:${hex}`], limit: 5 },
        ],
        { timeoutMs: 3000 },
      )
      .then(
        (evs) =>
          evs.some(
            (e) =>
              (e.kind === this.mod.CAPABILITY_CARD_KIND &&
                e.pubkey === hex &&
                !!this.mod.parseCapabilityCard(e as never)) ||
              (e.kind === this.mod.ATTESTATION_KIND &&
                this.mod.verifyAttestation(e as never, { agentPubkey: hex }).ok),
          ),
        () => false,
      );
    this.known.set(hex, { value: false, at: now, pending });
    const value = await pending;
    this.known.delete(hex);
    this.known.set(hex, { value, at: Date.now() });
    while (this.known.size > KNOWN_MAX) {
      const first = this.known.keys().next().value;
      if (first === undefined) break;
      this.known.delete(first);
    }
    return value;
  }

  subscribe(filter: unknown, onEvent: (ev: unknown) => void): () => void {
    const c = this.conn();
    const sub = c.pool.subscribe([filter], { onevent: onEvent });
    return () => sub.close();
  }
}

/** Build the nostr mesh provider if @beamhop/channel-nostr is installed. */
export const loadNostrMesh = async (d: Daemon): Promise<MeshProvider | undefined> => {
  try {
    const mod = (await import(/* @vite-ignore */ '@beamhop/channel-nostr')) as unknown as NostrMod;
    return new NostrMesh(d, mod);
  } catch {
    return undefined;
  }
};
