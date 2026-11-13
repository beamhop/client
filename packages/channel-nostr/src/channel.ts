// Nostr channel plugin (§4): NIP-17 DMs, NIP-29 groups, kind-1 notes, NIP-90 jobs.
import {
  type Attachment,
  BeamhopError,
  type ChannelConn,
  type ChannelContext,
  type ChannelPlugin,
  type InboundMsg,
  type InboundMsgInput,
  type Logger,
  OutboundMsg,
  type OutboundMsgInput,
  type SentMessage,
} from '@beamhop/core';
import type { Event, EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { minePow } from 'nostr-tools/nip13';
import * as nip17 from 'nostr-tools/nip17';
import * as nip19 from 'nostr-tools/nip19';
import { createRumor, createSeal, createWrap } from 'nostr-tools/nip59';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { decodeSecretKey, npubEncode, tryDecodePubkey } from './keys.ts';
import { LruMap, RateLimiter, SeenSet } from './lru.ts';
import { renderNostrText } from './markdown.ts';
import { type FetchLike, fetchRelayInfo } from './nip11.ts';
import { type PoolSub, type PublishResult, RelayPool, type WebSocketCtor } from './pool.ts';
import { AsyncQueue } from './queue.ts';
import {
  extractAttachments,
  hasHopsTag,
  hopsTag,
  imetaTags,
  mentions,
  parseHops,
  tagValue,
  tagValues,
  threadRefs,
} from './tags.ts';

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
/** Live-subscription replay window (§ task: connect time minus 2 minutes). */
export const LIVE_GRACE_S = 120;
const TWO_DAYS = 2 * 24 * 60 * 60;
const MAX_TEXT_CHUNK = 12_000;
export const PUBLIC_NOTES_PER_MINUTE = 6;

export interface NostrGroupRef {
  relay: string;
  id: string;
}

export interface NostrChannelSettings {
  relays: string[];
  groups?: NostrGroupRef[];
  publicNotes?: boolean;
  /** Display name for this agent on the channel. */
  name?: string;
  /** NIP-13 difficulty for outgoing public notes (default 0 = off). */
  powDifficulty?: number;
  /** Max public notes per minute (default 6). */
  publicNotesPerMinute?: number;
  /** Publish a kind 10050 DM relay list on connect (default true). */
  publishDmRelays?: boolean;
}

export interface NostrChannelDeps {
  WebSocket?: WebSocketCtor;
  fetch?: FetchLike;
  /** Seconds clock (tests). */
  now?: () => number;
  /** Override pool reconnect backoff (tests). */
  backoff?: { initialMs?: number; maxMs?: number };
}

export interface JobInfo {
  id: string;
  kind: number;
  resultKind: number;
  requester: string;
  inputs: { data: string; type: string; relay?: string; marker?: string }[];
  params: Record<string, string>;
  output?: string;
  relays: string[];
}

export type JobStatus = 'processing' | 'error' | 'success' | 'partial';

const groupHost = (relay: string): string =>
  relay
    .trim()
    .replace(/^wss?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

/** `<relay host>'<group id>` — NIP-29 group identifier. */
export const groupConversationId = (relay: string, id: string): string => `${groupHost(relay)}'${id}`;

export const parseGroupRef = (s: string | NostrGroupRef): NostrGroupRef => {
  if (typeof s !== 'string') {
    if (!s || typeof s.relay !== 'string' || typeof s.id !== 'string' || !s.id)
      throw new Error('invalid group');
    return { relay: s.relay, id: s.id };
  }
  const i = s.lastIndexOf("'");
  if (i <= 0 || i === s.length - 1) throw new Error(`invalid group "${s}" (expected relay'groupId)`);
  const relay = s.slice(0, i);
  return { relay: /^wss?:\/\//i.test(relay) ? relay : `wss://${relay}`, id: s.slice(i + 1) };
};

const isRelayUrl = (u: unknown): u is string => typeof u === 'string' && /^wss?:\/\/[^\s/]+/i.test(u);

export const parseSettings = (
  raw: Record<string, unknown>,
): Required<Omit<NostrChannelSettings, 'name'>> & {
  name?: string;
} => {
  const relays = Array.isArray(raw.relays) && raw.relays.length ? raw.relays : DEFAULT_RELAYS;
  for (const r of relays)
    if (!isRelayUrl(r)) throw new BeamhopError('invalid_input', `invalid relay URL: ${String(r)}`);
  const groups = Array.isArray(raw.groups) ? raw.groups.map((g) => parseGroupRef(g as NostrGroupRef)) : [];
  for (const g of groups)
    if (!isRelayUrl(g.relay)) throw new BeamhopError('invalid_input', `invalid group relay: ${g.relay}`);
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    relays: relays as string[],
    groups,
    publicNotes: raw.publicNotes === true || raw.publicNotes === 'true',
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    powDifficulty: Math.min(32, n(raw.powDifficulty, 0)),
    publicNotesPerMinute: n(raw.publicNotesPerMinute, PUBLIC_NOTES_PER_MINUTE),
    publishDmRelays: raw.publishDmRelays !== false,
  };
};

/** Split long text on paragraph/line boundaries so each event stays well under relay/NIP-44 limits. */
export const splitText = (text: string, max = MAX_TEXT_CHUNK): string[] => {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
};

const isJobKind = (k: number) => k >= 5000 && k <= 5999;

export const isJobMessage = (m: Pick<InboundMsg, 'raw'>): boolean =>
  !!(m.raw && typeof m.raw === 'object' && 'job' in (m.raw as object));

/** Extended connection: ChannelConn plus Nostr-only operations. */
export interface NostrConn extends ChannelConn {
  readonly pubkey: string;
  readonly npub: string;
  readonly pool: RelayPool;
  /** NIP-90 feedback (kind 7000). Payments are never requested. */
  jobFeedback(jobId: string, status: JobStatus, message?: string): Promise<PublishResult>;
  /** Sign with the agent key and publish to the main relays (profile, capability card…). */
  publish(t: EventTemplate, relays?: string[]): Promise<PublishResult>;
  status(): ReturnType<RelayPool['status']>;
}

class NostrConnection implements NostrConn {
  readonly provider = 'nostr';
  readonly capabilities = { edit: false, buttons: false, typing: false, files: true, threads: true };
  readonly self: ChannelConn['self'];
  readonly pubkey: string;
  readonly npub: string;
  readonly pool: RelayPool;

  private readonly sk: Uint8Array;
  private readonly log: Logger;
  private readonly queue = new AsyncQueue<InboundMsg>();
  private readonly seen = new SeenSet(10_000);
  private readonly sentIds = new SeenSet(5_000);
  private readonly threadOf = new LruMap<string, string>(10_000);
  private readonly authorOf = new LruMap<string, string>(10_000);
  private readonly jobs = new LruMap<string, Event>(1_000);
  private readonly recentByGroup = new Map<string, string[]>();
  private readonly dmRelayCache = new LruMap<string, { relays: string[]; at: number }>(500);
  private readonly publicLimiter: RateLimiter;
  private readonly removedHandlers = new Set<(conversationId: string) => void>();
  private readonly subs: PoolSub[] = [];
  private readonly mainRelays: string[];
  private readonly groups: (NostrGroupRef & { conv: string; relayUrl: string })[];
  private readonly settings: ReturnType<typeof parseSettings>;
  private readonly startedAt: number;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    readonly name: string,
    private readonly ctx: ChannelContext,
    private readonly deps: NostrChannelDeps,
  ) {
    this.settings = parseSettings(ctx.settings);
    const nsec = ctx.secrets.nsec;
    if (!nsec) throw new BeamhopError('invalid_input', 'nostr channel needs secret "nsec" (agent key)');
    try {
      this.sk = decodeSecretKey(nsec);
    } catch {
      throw new BeamhopError('invalid_input', 'nostr secret "nsec" is not a valid key');
    }
    this.pubkey = getPublicKey(this.sk);
    this.npub = npubEncode(this.pubkey);
    this.self = {
      principal: `nostr:${this.npub}`,
      displayName: this.settings.name ?? name,
      handle: this.npub,
    };
    this.log = ctx.log.child({ channel: name, provider: 'nostr' });
    this.startedAt = this.now();
    this.publicLimiter = new RateLimiter(this.settings.publicNotesPerMinute, 60_000, () => this.now() * 1000);
    this.pool = new RelayPool({
      relays: [],
      WebSocket: deps.WebSocket,
      log: this.log,
      signAuth: (t) => finalizeEvent(t, this.sk),
      ...(deps.backoff ? { backoff: deps.backoff } : {}),
    });
    this.mainRelays = this.settings.relays.map((r) => this.pool.addRelay(r));
    this.groups = this.settings.groups.map((g) => ({
      ...g,
      conv: groupConversationId(g.relay, g.id),
      relayUrl: this.pool.addRelay(g.relay),
    }));
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Math.floor(Date.now() / 1000);
  }

  async start(): Promise<void> {
    const persisted = await this.ctx.state.get<string[]>('seen').catch(() => undefined);
    if (Array.isArray(persisted)) for (const id of persisted.slice(-2000)) this.seen.add(id);

    const since = this.startedAt - LIVE_GRACE_S;
    this.subs.push(
      this.pool.subscribe(
        [
          // Gift wraps carry randomized created_at up to two days back (NIP-59).
          { kinds: [1059], '#p': [this.pubkey], since: since - TWO_DAYS },
          // Mentions, job requests and anything else addressed to us.
          { '#p': [this.pubkey], since },
        ],
        { onevent: (ev, relay) => this.handle(ev, relay) },
        { relays: this.mainRelays },
      ),
    );
    for (const g of this.groups) {
      this.subs.push(
        this.pool.subscribe(
          [{ kinds: [9, 11, 12, 9000, 9001], '#h': [g.id], since }],
          { onevent: (ev, relay) => this.handle(ev, relay) },
          { relays: [g.relayUrl] },
        ),
      );
    }
    const res = await this.pool.connect();
    if (!res.connected.length)
      this.log.warn('no relay reachable yet; retrying in background', { failed: res.failed });
    else this.log.info('nostr channel connected', { relays: res.connected.length, npub: this.npub });

    if (this.settings.publishDmRelays) {
      const t: EventTemplate = {
        kind: 10050,
        created_at: this.now(),
        tags: this.settings.relays.map((r) => ['relay', r]),
        content: '',
      };
      this.publish(t).catch(() => {});
    }
  }

  // ───────────────────────────── inbound ─────────────────────────────

  inbound(): AsyncIterable<InboundMsg> {
    return this.queue;
  }

  onRemoved(handler: (conversationId: string) => void): void {
    this.removedHandlers.add(handler);
  }

  private emit(m: InboundMsgInput): void {
    const parsed: InboundMsg = {
      attachments: [],
      mentionsAgent: false,
      replyToAgent: false,
      hops: 0,
      ...m,
      from: { isBot: false, ...m.from },
    } as InboundMsg;
    this.queue.push(parsed);
  }

  private markSeen(id: string): boolean {
    if (!this.seen.add(id)) return false;
    this.schedulePersist();
    return true;
  }

  private schedulePersist(): void {
    if (this.persistTimer || this.closed) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, 2000);
  }

  private persist(): void {
    this.ctx.state.set('seen', this.seen.values().slice(-2000)).catch(() => {});
  }

  private tooOld(createdAt: number): boolean {
    return createdAt < this.startedAt - LIVE_GRACE_S || createdAt > this.now() + 600;
  }

  private expired(tags: string[][]): boolean {
    const exp = tagValue(tags, 'expiration');
    return !!exp && /^\d+$/.test(exp) && Number(exp) <= this.now();
  }

  /** @internal exposed for tests */
  handle(ev: Event, relay: string): void {
    if (this.closed) return;
    try {
      if (ev.kind === 1059) this.handleGiftWrap(ev);
      else if (ev.pubkey === this.pubkey || this.expired(ev.tags)) return;
      else if ([9, 11, 12, 9000, 9001].includes(ev.kind) && tagValue(ev.tags, 'h') !== undefined)
        this.handleGroup(ev, relay);
      else if (ev.kind === 1) this.handleNote(ev);
      else if (isJobKind(ev.kind)) this.handleJob(ev);
    } catch (err) {
      this.log.warn('failed to handle event', { kind: ev.kind, error: String(err) });
    }
  }

  private threadFor(id: string, refs: { root?: string; reply?: string }, fallback: string): string {
    const t = refs.root ?? (refs.reply ? this.threadOf.get(refs.reply) : undefined) ?? fallback;
    this.threadOf.set(id, t);
    return t;
  }

  private handleGiftWrap(wrap: Event): void {
    if (!this.markSeen(wrap.id)) return;
    let rumor: ReturnType<typeof nip17.unwrapEvent>;
    try {
      rumor = nip17.unwrapEvent(wrap, this.sk);
    } catch (err) {
      this.log.debug('could not unwrap gift wrap', { error: String(err) });
      return;
    }
    if (rumor.pubkey === this.pubkey) return; // our own copy
    if (rumor.kind !== 14 && rumor.kind !== 15) return;
    if (!this.markSeen(rumor.id)) return;
    if (this.tooOld(rumor.created_at) || this.expired(rumor.tags)) return;

    const others = [...new Set([rumor.pubkey, ...tagValues(rumor.tags, 'p')])].filter(
      (p) => p !== this.pubkey && /^[0-9a-f]{64}$/.test(p),
    );
    const convId = others.length > 1 ? others.map(npubEncode).sort().join(',') : npubEncode(rumor.pubkey);
    const refs = threadRefs(rumor.tags);
    this.authorOf.set(rumor.id, rumor.pubkey);
    const threadId = this.threadFor(rumor.id, refs, convId);
    let text = rumor.content;
    const attachments: Attachment[] = extractAttachments(rumor);
    if (rumor.kind === 15) {
      // NIP-17 encrypted file message: the URL points at AES-GCM ciphertext.
      const mime = tagValue(rumor.tags, 'file-type') ?? 'application/octet-stream';
      text = '';
      if (/^https?:\/\//.test(rumor.content))
        attachments.push({ name: rumor.content.split('/').pop() || 'file', mime, url: rumor.content });
    }
    const subject = tagValue(rumor.tags, 'subject');
    this.emit({
      id: rumor.id,
      channel: this.name,
      provider: 'nostr',
      conversation: { kind: 'dm', id: convId, ...(subject ? { title: subject } : {}) },
      threadId,
      from: { principal: `nostr:${npubEncode(rumor.pubkey)}`, isBot: hasHopsTag(rumor.tags) },
      text,
      attachments,
      mentionsAgent: true,
      replyToAgent: !!refs.reply && this.sentIds.has(refs.reply),
      ...(refs.reply ? { replyToId: refs.reply } : {}),
      hops: parseHops(rumor.tags),
      receivedAt: new Date().toISOString(),
      raw: {
        rumor,
        ...(rumor.kind === 15 ? { file: Object.fromEntries(rumor.tags.map((t) => [t[0], t[1]])) } : {}),
      },
    });
  }

  private handleGroup(ev: Event, relay: string): void {
    const h = tagValue(ev.tags, 'h')!;
    // NIP-29: the group's relay is the authority; ignore copies seen elsewhere.
    const g = this.groups.find((x) => x.id === h && x.relayUrl === relay);
    if (!g) return;
    if (!this.markSeen(ev.id)) return;
    if (this.tooOld(ev.created_at)) return;
    this.rememberRecent(g.conv, ev.id);

    if (ev.kind === 9000 || ev.kind === 9001) {
      if (ev.kind === 9001 && tagValues(ev.tags, 'p').includes(this.pubkey)) {
        this.log.info('removed from group', { group: g.conv });
        for (const fn of this.removedHandlers) fn(g.conv);
      }
      return;
    }
    const refs = threadRefs(ev.tags);
    this.authorOf.set(ev.id, ev.pubkey);
    const threadId = this.threadFor(ev.id, refs, ev.kind === 11 ? ev.id : g.conv);
    const title = ev.kind === 11 ? tagValue(ev.tags, 'title') : undefined;
    this.emit({
      id: ev.id,
      channel: this.name,
      provider: 'nostr',
      conversation: { kind: 'group', id: g.conv, title: g.id },
      threadId,
      from: { principal: `nostr:${npubEncode(ev.pubkey)}`, isBot: hasHopsTag(ev.tags) },
      text: title ? `${title}\n\n${ev.content}` : ev.content,
      attachments: extractAttachments(ev),
      mentionsAgent: mentions(ev, this.pubkey),
      replyToAgent: !!refs.reply && this.sentIds.has(refs.reply),
      ...(refs.reply ? { replyToId: refs.reply } : {}),
      hops: parseHops(ev.tags),
      receivedAt: new Date().toISOString(),
      raw: { event: ev, relay },
    });
  }

  private handleNote(ev: Event): void {
    if (!this.settings.publicNotes) return;
    if (!tagValues(ev.tags, 'p').includes(this.pubkey)) return; // respond to p-tag mentions only
    if (!this.markSeen(ev.id)) return;
    if (this.tooOld(ev.created_at)) return;
    const refs = threadRefs(ev.tags);
    this.authorOf.set(ev.id, ev.pubkey);
    const threadId = this.threadFor(ev.id, refs, ev.id);
    this.emit({
      id: ev.id,
      channel: this.name,
      provider: 'nostr',
      conversation: { kind: 'public', id: 'notes' },
      threadId,
      from: { principal: `nostr:${npubEncode(ev.pubkey)}`, isBot: hasHopsTag(ev.tags) },
      text: ev.content,
      attachments: extractAttachments(ev),
      mentionsAgent: true,
      replyToAgent: !!refs.reply && this.sentIds.has(refs.reply),
      ...(refs.reply ? { replyToId: refs.reply } : {}),
      hops: parseHops(ev.tags),
      receivedAt: new Date().toISOString(),
      raw: { event: ev },
    });
  }

  private handleJob(ev: Event): void {
    if (!tagValues(ev.tags, 'p').includes(this.pubkey)) return;
    if (!this.markSeen(ev.id)) return;
    if (this.tooOld(ev.created_at)) return;
    this.jobs.set(ev.id, ev);
    this.authorOf.set(ev.id, ev.pubkey);
    this.threadOf.set(ev.id, ev.id);
    if (ev.tags.some((t) => t[0] === 'encrypted')) {
      this.jobFeedback(ev.id, 'error', 'encrypted job requests are not supported').catch(() => {});
      return;
    }
    // NOTE: `amount` / `bid` tags are deliberately ignored — beamhop never requests payment.
    const inputs = ev.tags
      .filter((t) => t[0] === 'i' && typeof t[1] === 'string')
      .map((t) => ({
        data: t[1]!,
        type: t[2] || 'text',
        ...(t[3] ? { relay: t[3] } : {}),
        ...(t[4] ? { marker: t[4] } : {}),
      }));
    const params: Record<string, string> = {};
    for (const t of ev.tags) if (t[0] === 'param' && t[1] && t[2] !== undefined) params[t[1]] = t[2];
    const output = tagValue(ev.tags, 'output');
    const relays = (ev.tags.find((t) => t[0] === 'relays') ?? []).slice(1).filter(isRelayUrl).slice(0, 5);
    const job: JobInfo = {
      id: ev.id,
      kind: ev.kind,
      resultKind: ev.kind + 1000,
      requester: ev.pubkey,
      inputs,
      params,
      ...(output ? { output } : {}),
      relays,
    };
    const lines: string[] = [];
    for (const i of inputs) {
      if (i.type === 'text') lines.push(i.data);
      else if (i.type === 'url') lines.push(`Input URL: ${i.data}`);
      else if (i.type === 'event')
        lines.push(
          `Input event: ${/^[0-9a-f]{64}$/.test(i.data) ? `nostr:${nip19.noteEncode(i.data)}` : i.data}`,
        );
      else if (i.type === 'job') lines.push(`Input job result: ${i.data}`);
    }
    if (ev.content.trim()) lines.push(ev.content.trim());
    for (const [k, v] of Object.entries(params)) lines.push(`param ${k}: ${v}`);
    if (output) lines.push(`Requested output format: ${output}`);
    const attachments = inputs
      .filter((i) => i.type === 'url')
      .flatMap((i) => extractAttachments({ tags: [], content: i.data }));
    const requester = npubEncode(ev.pubkey);
    this.emit({
      id: ev.id,
      channel: this.name,
      provider: 'nostr',
      conversation: { kind: 'dm', id: requester, title: `NIP-90 job kind ${ev.kind}` },
      threadId: ev.id,
      from: { principal: `nostr:${requester}`, isBot: true },
      text: lines.join('\n\n'),
      attachments,
      mentionsAgent: true,
      replyToAgent: false,
      hops: parseHops(ev.tags),
      receivedAt: new Date().toISOString(),
      raw: { job, event: ev },
    });
  }

  private rememberRecent(conv: string, id: string): void {
    const list = this.recentByGroup.get(conv) ?? [];
    list.push(id);
    if (list.length > 50) list.splice(0, list.length - 50);
    this.recentByGroup.set(conv, list);
  }

  // ───────────────────────────── outbound ─────────────────────────────

  async typing(_conversationId: string): Promise<void> {
    // Nostr has no typing indicator we can rely on; no-op (capabilities.typing = false).
  }

  private bodyFor(msg: OutboundMsg): string {
    let text = renderNostrText(msg.markdown);
    const urls = msg.attachments.map((a) => a.url).filter((u): u is string => !!u && !text.includes(u));
    if (urls.length) text = `${text}${text ? '\n\n' : ''}${urls.join('\n')}`;
    return text;
  }

  private commonTags(msg: OutboundMsg): string[][] {
    const tags: string[][] = [];
    if (msg.hops !== undefined) tags.push(hopsTag(msg.hops));
    tags.push(...imetaTags(msg.attachments));
    return tags;
  }

  async send(input: OutboundMsgInput): Promise<SentMessage> {
    if (this.closed) throw new BeamhopError('unavailable', 'nostr channel closed');
    const msg = OutboundMsg.parse(input);
    const body = this.bodyFor(msg);
    if (!body.trim()) throw new BeamhopError('invalid_input', 'empty message');
    // A send into a NIP-90 job thread is the job result (one event, not split).
    const job = msg.threadId ? this.jobs.get(msg.threadId) : undefined;
    if (job && msg.conversation.kind === 'dm') return this.sendJobResult(job, msg, body);
    const parts = splitText(body);
    let first: SentMessage | undefined;
    let replyTo = msg.replyToId;
    for (const [i, part] of parts.entries()) {
      // Only the first part carries attachments' imeta tags; later parts reply to the previous one.
      const m: OutboundMsg = {
        ...msg,
        ...(i > 0 ? { attachments: [] } : {}),
        ...(replyTo ? { replyToId: replyTo } : {}),
      };
      const sent = await this.sendOne(m, part);
      first ??= sent;
      replyTo = sent.id;
    }
    return first!;
  }

  private async sendOne(msg: OutboundMsg, text: string): Promise<SentMessage> {
    const conv = msg.conversation;
    switch (conv.kind) {
      case 'dm':
        return this.sendDm(msg, text);
      case 'group':
        return this.sendGroup(msg, text);
      case 'public':
        return this.sendNote(msg, text);
      default:
        throw new BeamhopError('invalid_input', `nostr does not support conversation kind ${conv.kind}`);
    }
  }

  private recordSent(id: string, threadId: string | undefined): void {
    this.sentIds.add(id);
    this.authorOf.set(id, this.pubkey);
    if (threadId) this.threadOf.set(id, threadId);
    this.seen.add(id);
  }

  private ensureDelivered(r: PublishResult, what: string): void {
    if (!r.ok.length) {
      throw new BeamhopError('unavailable', `${what} not accepted by any relay`, {
        failed: r.failed.map((f) => `${f.relay}: ${f.reason}`),
      });
    }
  }

  private async dmRelaysFor(pubkey: string): Promise<string[]> {
    const cached = this.dmRelayCache.get(pubkey);
    if (cached && this.now() - cached.at < 3600) return cached.relays;
    const evs = await this.pool.query([{ kinds: [10050], authors: [pubkey], limit: 1 }], {
      relays: this.mainRelays,
      timeoutMs: 2500,
    });
    const latest = evs.sort((a, b) => b.created_at - a.created_at)[0];
    const relays = latest ? tagValues(latest.tags, 'relay').filter(isRelayUrl).slice(0, 5) : [];
    this.dmRelayCache.set(pubkey, { relays, at: this.now() });
    return relays;
  }

  private async sendDm(msg: OutboundMsg, text: string): Promise<SentMessage> {
    const recipients = msg.conversation.id.split(',').map((p) => {
      const pk = tryDecodePubkey(p);
      if (!pk) throw new BeamhopError('invalid_input', `invalid DM recipient: ${p}`);
      return pk;
    });
    const tags: string[][] = recipients.map((p) => ['p', p]);
    const threadId = msg.threadId && msg.threadId !== msg.conversation.id ? msg.threadId : undefined;
    if (threadId && /^[0-9a-f]{64}$/.test(threadId)) tags.push(['e', threadId, '', 'root']);
    if (msg.replyToId && /^[0-9a-f]{64}$/.test(msg.replyToId) && msg.replyToId !== threadId)
      tags.push(['e', msg.replyToId, '', 'reply']);
    tags.push(...this.commonTags(msg));
    const rumor = createRumor({ kind: 14, content: text, tags, created_at: this.now() }, this.sk);
    const results = await Promise.all(
      recipients.map(async (pk) => {
        const wrap = createWrap(createSeal(rumor, this.sk, pk), pk);
        const theirs = await this.dmRelaysFor(pk).catch(() => [] as string[]);
        return this.pool.publish(wrap, { relays: [...new Set([...this.mainRelays, ...theirs])], quorum: 1 });
      }),
    );
    for (const r of results) this.ensureDelivered(r, 'DM');
    // Copy to self so other devices of this agent can see the history.
    const selfWrap = createWrap(createSeal(rumor, this.sk, this.pubkey), this.pubkey);
    this.seen.add(selfWrap.id);
    this.pool.publish(selfWrap, { relays: this.mainRelays }).catch(() => {});
    this.recordSent(rumor.id, msg.threadId ?? msg.conversation.id);
    return { id: rumor.id };
  }

  private groupFor(convId: string) {
    const g =
      this.groups.find((x) => x.conv === convId) ?? this.groups.find((x) => x.conv === convId.toLowerCase());
    if (!g) throw new BeamhopError('not_found', `group ${convId} is not configured on channel ${this.name}`);
    return g;
  }

  private async sendGroup(msg: OutboundMsg, text: string): Promise<SentMessage> {
    const g = this.groupFor(msg.conversation.id);
    const tags: string[][] = [['h', g.id]];
    const threadId = msg.threadId && msg.threadId !== g.conv ? msg.threadId : undefined;
    if (threadId && /^[0-9a-f]{64}$/.test(threadId)) tags.push(['e', threadId, g.relay, 'root']);
    if (msg.replyToId && /^[0-9a-f]{64}$/.test(msg.replyToId)) {
      if (msg.replyToId !== threadId) tags.push(['e', msg.replyToId, g.relay, 'reply']);
      const author = this.authorOf.get(msg.replyToId);
      if (author && author !== this.pubkey) tags.push(['p', author]);
    }
    const recent = this.recentByGroup.get(g.conv) ?? [];
    const prev = recent.slice(-5).map((id) => id.slice(0, 8));
    if (prev.length) tags.push(['previous', ...prev]);
    tags.push(...this.commonTags(msg));
    const ev = finalizeEvent({ kind: 9, created_at: this.now(), tags, content: text }, this.sk);
    const r = await this.pool.publish(ev, { relays: [g.relayUrl] });
    this.ensureDelivered(r, 'group message');
    this.rememberRecent(g.conv, ev.id);
    this.recordSent(ev.id, msg.threadId ?? g.conv);
    return { id: ev.id };
  }

  private async sendNote(msg: OutboundMsg, text: string): Promise<SentMessage> {
    if (!this.settings.publicNotes)
      throw new BeamhopError('forbidden', `public notes are disabled on channel ${this.name}`);
    if (!this.publicLimiter.take())
      throw new BeamhopError('rate_limited', 'public note rate limit reached', {
        retryAfterMs: this.publicLimiter.retryAfterMs(),
      });
    const tags: string[][] = [];
    if (msg.replyToId && /^[0-9a-f]{64}$/.test(msg.replyToId)) {
      // NIP-10 marked e tags: root, then reply.
      const root =
        msg.threadId && /^[0-9a-f]{64}$/.test(msg.threadId) && msg.threadId !== msg.replyToId
          ? msg.threadId
          : undefined;
      if (root) tags.push(['e', root, '', 'root']);
      tags.push(['e', msg.replyToId, '', root ? 'reply' : 'root']);
      const ps = new Set<string>();
      for (const id of [msg.replyToId, root]) {
        const a = id ? this.authorOf.get(id) : undefined;
        if (a && a !== this.pubkey) ps.add(a);
      }
      for (const p of ps) tags.push(['p', p]);
    }
    tags.push(...this.commonTags(msg));
    const ev = this.signMaybePow({ kind: 1, created_at: this.now(), tags, content: text });
    const r = await this.pool.publish(ev, { relays: this.mainRelays, quorum: 1 });
    this.ensureDelivered(r, 'note');
    this.recordSent(ev.id, msg.threadId ?? msg.replyToId ?? ev.id);
    return { id: ev.id };
  }

  private signMaybePow(t: EventTemplate): VerifiedEvent {
    const d = this.settings.powDifficulty;
    if (!d) return finalizeEvent(t, this.sk);
    const mined = minePow({ ...t, pubkey: this.pubkey }, d);
    return finalizeEvent(
      { kind: mined.kind, created_at: mined.created_at, tags: mined.tags, content: mined.content },
      this.sk,
    );
  }

  private jobRelays(job: Event): string[] {
    const extra = (job.tags.find((t) => t[0] === 'relays') ?? []).slice(1).filter(isRelayUrl).slice(0, 5);
    return [...new Set([...this.mainRelays, ...extra.map((r) => this.pool.addRelay(r))])];
  }

  private async sendJobResult(job: Event, msg: OutboundMsg, text: string): Promise<SentMessage> {
    const tags: string[][] = [
      ['request', JSON.stringify(job)],
      ['e', job.id, this.mainRelays[0] ?? ''],
      ...job.tags.filter((t) => t[0] === 'i'),
      ['p', job.pubkey],
      ...this.commonTags(msg),
    ];
    const ev = finalizeEvent({ kind: job.kind + 1000, created_at: this.now(), tags, content: text }, this.sk);
    const r = await this.pool.publish(ev, { relays: this.jobRelays(job), quorum: 1 });
    this.ensureDelivered(r, 'job result');
    this.recordSent(ev.id, job.id);
    return { id: ev.id };
  }

  async jobFeedback(jobId: string, status: JobStatus, message = ''): Promise<PublishResult> {
    const job = this.jobs.get(jobId);
    if (!job) throw new BeamhopError('not_found', `unknown job ${jobId}`);
    const ev = finalizeEvent(
      {
        kind: 7000,
        created_at: this.now(),
        tags: [
          ['status', status, ...(message ? [message.slice(0, 280)] : [])],
          ['e', job.id, this.mainRelays[0] ?? ''],
          ['p', job.pubkey],
        ],
        content: message,
      },
      this.sk,
    );
    return this.pool.publish(ev, { relays: this.jobRelays(job), quorum: 1 });
  }

  async publish(t: EventTemplate, relays?: string[]): Promise<PublishResult> {
    const ev = finalizeEvent(t, this.sk);
    return this.pool.publish(ev, { relays: relays ?? this.mainRelays });
  }

  status() {
    return this.pool.status();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persist();
    for (const s of this.subs) s.close();
    this.pool.close();
    this.queue.end();
  }
}

export type NostrChannelPlugin = Omit<ChannelPlugin, 'connect'> & {
  connect(ctx: ChannelContext): Promise<NostrConn>;
};

export const createNostrChannel = (deps: NostrChannelDeps = {}): NostrChannelPlugin => ({
  id: 'nostr',
  displayName: 'Nostr',
  setup: {
    steps: [
      {
        id: 'key',
        title: 'Agent key',
        body: 'Each agent has its **own** Nostr key — never use your personal key. Run `beamhop identity new` to generate one, then paste the `nsec` here. It is stored in the OS keychain.',
        fields: [
          { kind: 'secret', id: 'nsec', label: 'Agent nsec', envFlag: 'BEAMHOP_NOSTR_NSEC' },
          { kind: 'text', id: 'name', label: 'Display name', optional: true },
        ],
      },
      {
        id: 'relays',
        title: 'Relays',
        body: "Relays used for DMs, notes and jobs. Groups are NIP-29 groups written as `relay'groupId`.",
        fields: [
          { kind: 'list', id: 'relays', label: 'Relays', default: DEFAULT_RELAYS },
          { kind: 'list', id: 'groups', label: "NIP-29 groups (relay'groupId)", default: [] },
          {
            kind: 'select',
            id: 'publicNotes',
            label: 'Reply to public mentions (kind 1)?',
            options: [
              { value: 'false', label: 'No (recommended)' },
              { value: 'true', label: 'Yes, rate-limited' },
            ],
          },
        ],
      },
    ],
    async validate(values, secrets) {
      let pk: string;
      try {
        pk = getPublicKey(decodeSecretKey(secrets.nsec ?? ''));
      } catch {
        return { ok: false, message: 'That is not a valid nsec.' };
      }
      let settings: ReturnType<typeof parseSettings>;
      try {
        settings = parseSettings(values);
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
      const urls = [...new Set([...settings.relays, ...settings.groups.map((g) => g.relay)])];
      const checks = await Promise.all(
        urls.map((u) =>
          fetchRelayInfo(u, { ...(deps.fetch ? { fetch: deps.fetch } : {}), timeoutMs: 6000 }).then(
            (i) => ({ u, ok: true, nips: i.supported_nips ?? [] }),
            () => ({ u, ok: false, nips: [] as number[] }),
          ),
        ),
      );
      const up = checks.filter((c) => c.ok);
      const badGroups = settings.groups.filter((g) => {
        const c = checks.find((x) => x.u === g.relay);
        return !c?.ok || !c.nips.map(Number).includes(29);
      });
      if (!up.length) return { ok: false, message: 'None of the relays answered (NIP-11).' };
      const npub = npubEncode(pk);
      const warn = [
        up.length < checks.length
          ? `unreachable: ${checks
              .filter((c) => !c.ok)
              .map((c) => c.u)
              .join(', ')}`
          : '',
        badGroups.length ? `not NIP-29 relays: ${badGroups.map((g) => g.relay).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      return {
        ok: true,
        message: `Connected to ${up.length}/${checks.length} relays${warn ? ` (${warn})` : ''}.`,
        identity: {
          name: settings.name ?? (typeof values.name === 'string' ? values.name : 'Nostr agent'),
          handle: npub,
        },
      };
    },
  },
  async connect(ctx) {
    const conn = new NostrConnection(ctx.name, ctx, deps);
    await conn.start();
    return conn;
  },
});

/** Default plugin instance (global WebSocket / fetch). */
export const nostrChannel: NostrChannelPlugin = createNostrChannel();
