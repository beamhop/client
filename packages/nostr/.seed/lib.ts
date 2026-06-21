/**
 * Shared seeding library for the Beamhop content test.
 *
 * Run any script importing this from within packages/nostr so that
 * `nostr-tools` resolves from packages/nostr/node_modules.
 */
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  SimplePool,
} from "nostr-tools";
import type { Event as NostrEvent, EventTemplate } from "nostr-tools";
import { homedir } from "node:os";
import { join } from "node:path";

export const RELAY = "wss://relay2.beamhop.com";
export const COMPANY_PATH = join(homedir(), "Desktop", "company.json");

// Beamhop long-form markers (kind 30023): doc vs article.
const DOC_MARKER = "beamhop-doc";
const ARTICLE_MARKER = "beamhop-article";

// NIP-27 mention regex (mirrors packages/nostr/src/mentions.ts).
const MENTION_RE =
  /(?:nostr:)?@?((?:npub|nprofile)1[023456789acdefghjklmnpqrstuvwxyz]+)/g;

export type MemberType = "human" | "agent";

export type ProfileMeta = {
  name: string;
  display_name: string;
  about: string;
  picture: string;
  nip05: string;
  website?: string;
  role: string;
};

export type Member = {
  handle: string;
  type: MemberType;
  role: string;
  profile: ProfileMeta;
  keys: {
    secretHex: string;
    nsec: string;
    pubkey: string;
    npub: string;
  };
};

export type Company = {
  relay: string;
  createdAt: string;
  members: Member[];
};

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const fromHex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/.{2}/g)!.map((h) => Number.parseInt(h, 16)));

const now = (): number => Math.floor(Date.now() / 1000);

/** Generate a fresh identity for a member spec. */
export const makeMember = (spec: {
  handle: string;
  type: MemberType;
  role: string;
  profile: ProfileMeta;
}): Member => {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  return {
    handle: spec.handle,
    type: spec.type,
    role: spec.role,
    profile: spec.profile,
    keys: {
      secretHex: hex(sk),
      nsec: nip19.nsecEncode(sk),
      pubkey,
      npub: nip19.npubEncode(pubkey),
    },
  };
};

/** Inline NIP-27 mention token for a member, e.g. `nostr:npub1…`. */
export const mention = (m: Member): string => `nostr:${m.keys.npub}`;

const pubkeyOf = (entity: string): string | null => {
  try {
    const decoded = nip19.decode(entity);
    if (decoded.type === "npub") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
    return null;
  } catch {
    return null;
  }
};

const mentionedPubkeys = (content: string): string[] => {
  const seen = new Set<string>();
  for (const match of content.matchAll(MENTION_RE)) {
    const pk = match[1] ? pubkeyOf(match[1]) : null;
    if (pk) seen.add(pk);
  }
  return [...seen];
};

const extractHashtags = (content: string): string[] => {
  const tags = new Set<string>();
  for (const m of content.matchAll(/(?:^|\s)#([a-z0-9_-]+)/gi)) tags.add(m[1]);
  return [...tags];
};

export type Posted = { id: string; pubkey: string; created_at: number };

export class Publisher {
  private pool = new SimplePool();
  private clock = now();

  constructor(private readonly relays: string[] = [RELAY]) {}

  /** Monotonic, slightly-spaced timestamps so threads order correctly. */
  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  private sign(member: Member, template: EventTemplate): NostrEvent {
    return finalizeEvent(template, fromHex(member.keys.secretHex));
  }

  private async send(event: NostrEvent): Promise<Posted> {
    await Promise.any(this.pool.publish(this.relays, event)).catch(() => {
      throw new Error(`No relay accepted event ${event.id}`);
    });
    return { id: event.id, pubkey: event.pubkey, created_at: event.created_at };
  }

  /** Publish a kind 0 profile. */
  async profile(member: Member): Promise<Posted> {
    const event = this.sign(member, {
      kind: 0,
      created_at: this.tick(),
      tags: [],
      content: JSON.stringify(member.profile),
    });
    return this.send(event);
  }

  /** Publish a top-level kind 1 note. Mentions/hashtags auto-tagged. */
  async note(member: Member, content: string): Promise<Posted> {
    const tags: string[][] = [];
    for (const pk of mentionedPubkeys(content)) tags.push(["p", pk]);
    for (const t of extractHashtags(content)) tags.push(["t", t]);
    const event = this.sign(member, {
      kind: 1,
      created_at: this.tick(),
      tags,
      content,
    });
    return this.send(event);
  }

  /**
   * Publish a kind 1 reply (NIP-10). `parent` is the note being replied to;
   * `root` is the conversation root (defaults to parent for a direct reply).
   */
  async reply(
    member: Member,
    content: string,
    parent: Posted,
    root?: Posted,
  ): Promise<Posted> {
    const r = root ?? parent;
    const tags: string[][] = [];
    tags.push(["e", r.id, "", "root"]);
    if (r.id !== parent.id) tags.push(["e", parent.id, "", "reply"]);
    const pSet = new Set<string>([parent.pubkey]);
    for (const pk of mentionedPubkeys(content)) pSet.add(pk);
    for (const pk of pSet) tags.push(["p", pk]);
    for (const t of extractHashtags(content)) tags.push(["t", t]);
    const event = this.sign(member, {
      kind: 1,
      created_at: this.tick(),
      tags,
      content,
    });
    return this.send(event);
  }

  /** React (kind 7) to a note. */
  async react(member: Member, target: Posted, content = "+"): Promise<Posted> {
    const event = this.sign(member, {
      kind: 7,
      created_at: this.tick(),
      tags: [
        ["e", target.id],
        ["p", target.pubkey],
      ],
      content,
    });
    return this.send(event);
  }

  /** Publish a kind 30023 long-form doc or article. */
  async longForm(
    member: Member,
    input: {
      identifier: string;
      title: string;
      summary: string;
      body: string;
      image?: string;
      hashtags?: string[];
      kind: "doc" | "article";
    },
  ): Promise<Posted & { address: string }> {
    const marker = input.kind === "doc" ? DOC_MARKER : ARTICLE_MARKER;
    const ts = this.tick();
    const tags: string[][] = [
      ["d", input.identifier],
      ["title", input.title],
      ["summary", input.summary],
      ["published_at", String(ts)],
      ["t", marker],
      ...(input.hashtags ?? []).map((h) => ["t", h]),
    ];
    if (input.image) tags.push(["image", input.image]);
    const event = this.sign(member, {
      kind: 30023,
      created_at: ts,
      tags,
      content: input.body,
    });
    const posted = await this.send(event);
    return {
      ...posted,
      address: `30023:${member.keys.pubkey}:${input.identifier}`,
    };
  }

  close(): void {
    this.pool.close(this.relays);
  }
}

export const loadCompany = async (): Promise<Company> => {
  const file = Bun.file(COMPANY_PATH);
  return (await file.json()) as Company;
};

export const byHandle = (company: Company): Record<string, Member> =>
  Object.fromEntries(company.members.map((m) => [m.handle, m]));
