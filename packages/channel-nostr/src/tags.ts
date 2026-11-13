// Browser-compatible helpers for event tags.
import type { Attachment } from '@beamhop/core';
import { tryDecodePubkey } from './keys.ts';

export const HOPS_TAG = 'beamhop-hops';
/** Hard ceiling on parsed hop counts, to keep a malicious value from overflowing counters. */
export const MAX_HOPS = 1000;

type Tags = string[][];

export const tagValue = (tags: Tags, name: string): string | undefined =>
  tags.find((t) => t[0] === name)?.[1];
export const tagValues = (tags: Tags, name: string): string[] =>
  tags.filter((t) => t[0] === name && typeof t[1] === 'string').map((t) => t[1]!);

/** `["beamhop-hops","<n>"]` */
export const hopsTag = (n: number): string[] => [HOPS_TAG, String(Math.max(0, Math.floor(n)))];

/** Parse the mesh hop counter. Missing/invalid → 0. */
export const parseHops = (tags: Tags): number => {
  const v = tagValue(tags, HOPS_TAG);
  if (v === undefined || !/^\d{1,6}$/.test(v)) return 0;
  return Math.min(MAX_HOPS, Number.parseInt(v, 10));
};

export const hasHopsTag = (tags: Tags): boolean => tags.some((t) => t[0] === HOPS_TAG);

const NOSTR_URI = /nostr:(npub1[02-9ac-hj-np-z]{58}|nprofile1[02-9ac-hj-np-z]+)/g;

/** Pubkeys referenced as `nostr:npub…`/`nostr:nprofile…` in content. */
export const contentMentions = (content: string): string[] => {
  const out = new Set<string>();
  for (const m of content.matchAll(NOSTR_URI)) {
    const pk = tryDecodePubkey(m[1]!);
    if (pk) out.add(pk);
  }
  return [...out];
};

/** True if the event p-tags `pubkey` or mentions it via a nostr: URI in content. */
export const mentions = (ev: { tags: Tags; content: string }, pubkey: string): boolean =>
  tagValues(ev.tags, 'p').includes(pubkey) || contentMentions(ev.content).includes(pubkey);

export interface ThreadRefs {
  root?: string;
  reply?: string;
}

/**
 * NIP-10 style e-tag parsing with markers, falling back to positional (deprecated) form.
 * Also honours `q` tags (NIP-C7 chat replies) as a reply reference.
 */
export const threadRefs = (tags: Tags): ThreadRefs => {
  const es = tags.filter((t) => t[0] === 'e' && typeof t[1] === 'string' && /^[0-9a-f]{64}$/.test(t[1]));
  let root = es.find((t) => t[3] === 'root')?.[1];
  let reply = es.find((t) => t[3] === 'reply')?.[1];
  const marked = es.some((t) => t[3] === 'root' || t[3] === 'reply' || t[3] === 'mention');
  if (!marked && es.length) {
    root = es[0]![1];
    reply = es[es.length - 1]![1];
  }
  if (!reply) {
    const q = tags.find((t) => t[0] === 'q' && typeof t[1] === 'string' && /^[0-9a-f]{64}$/.test(t[1]))?.[1];
    reply = q ?? root;
  }
  const out: ThreadRefs = {};
  if (root) out.root = root;
  if (reply) out.reply = reply;
  return out;
};

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  zip: 'application/zip',
};

const FILE_URL = /https?:\/\/[^\s<>"']+\.([a-z0-9]{2,5})(?=$|[\s?#)\]"'<>])/gi;

/** Attachments from NIP-92 `imeta` tags plus bare file URLs in content. */
export const extractAttachments = (ev: { tags: Tags; content: string }): Attachment[] => {
  const byUrl = new Map<string, Attachment>();
  for (const t of ev.tags) {
    if (t[0] !== 'imeta') continue;
    const fields: Record<string, string> = {};
    for (const part of t.slice(1)) {
      const sp = part.indexOf(' ');
      if (sp > 0) fields[part.slice(0, sp)] = part.slice(sp + 1);
    }
    const url = fields.url;
    if (!url || !/^https?:\/\//.test(url)) continue;
    const a: Attachment = {
      name: decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'file'),
      mime: fields.m ?? 'application/octet-stream',
      url,
    };
    if (fields.x && /^[0-9a-f]{64}$/.test(fields.x)) a.sha256 = fields.x;
    if (fields.size && /^\d+$/.test(fields.size)) a.size = Number(fields.size);
    byUrl.set(url, a);
  }
  for (const m of ev.content.matchAll(FILE_URL)) {
    const url = m[0];
    const ext = m[1]!.toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime || byUrl.has(url)) continue;
    byUrl.set(url, { name: decodeURIComponent(url.split('/').pop() || 'file'), mime, url });
  }
  return [...byUrl.values()];
};

/** Build NIP-92 imeta tags for outbound attachments that have URLs. */
export const imetaTags = (atts: Attachment[]): string[][] =>
  atts
    .filter((a) => a.url)
    .map((a) => {
      const t = ['imeta', `url ${a.url}`, `m ${a.mime}`];
      if (a.sha256) t.push(`x ${a.sha256}`);
      if (a.size !== undefined) t.push(`size ${a.size}`);
      return t;
    });
