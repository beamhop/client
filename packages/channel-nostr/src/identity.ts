// Public identity helpers (§4): profile, owner attestation, NIP-89 capability card, NIP-05.
// Browser-compatible.
import type { Event, EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { decodePubkey, decodeSecretKey, npubEncode } from './keys.ts';
import { tagValue } from './tags.ts';

export const ATTESTATION_KIND = 30078;
export const CAPABILITY_CARD_KIND = 31990;
export const attestationD = (agentPubkey: string): string => `beamhop-agent:${agentPubkey}`;

const nowSec = () => Math.floor(Date.now() / 1000);

export const signEvent = (t: EventTemplate, key: string | Uint8Array): VerifiedEvent =>
  finalizeEvent({ ...t, tags: t.tags.map((x) => [...x]) }, decodeSecretKey(key));

// ───────────────────────────── kind 0 profile ─────────────────────────────

export interface ProfileMeta {
  name: string;
  displayName?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  /** Owner npub or hex — required for the AI disclosure line. */
  owner: string;
}

/** kind 0 profile with `bot: true` and an AI-disclosure line naming the owner (§4, AI disclosure). */
export const buildProfileEvent = (meta: ProfileMeta): EventTemplate => {
  const ownerNpub = npubEncode(decodePubkey(meta.owner));
  const disclosure = `AI agent operated by ${ownerNpub}`;
  const about = meta.about?.trim() ? `${meta.about.trim()}\n\n${disclosure}` : disclosure;
  const content: Record<string, unknown> = {
    name: meta.name,
    display_name: meta.displayName ?? meta.name,
    about,
    bot: true,
  };
  if (meta.picture) content.picture = meta.picture;
  if (meta.banner) content.banner = meta.banner;
  if (meta.website) content.website = meta.website;
  if (meta.nip05) content.nip05 = meta.nip05;
  return {
    kind: 0,
    created_at: nowSec(),
    tags: [['p', decodePubkey(meta.owner), '', 'owner']],
    content: JSON.stringify(content),
  };
};

// ───────────────────────────── owner attestation ─────────────────────────────

export interface AttestationOptions {
  name?: string;
  /** Publish a replacement marking the agent as no longer operated by this owner. */
  revoked?: boolean;
  createdAt?: number;
}

/**
 * Owner-signed attestation linking an agent pubkey to the owner (kind 30078, d=`beamhop-agent:<agent>`).
 * Signed with the owner's key; the agent never holds owner keys (§7A).
 */
export const buildAttestation = (
  ownerKey: string | Uint8Array,
  agentPubkey: string,
  opts: AttestationOptions = {},
): VerifiedEvent => {
  const sk = decodeSecretKey(ownerKey);
  const agent = decodePubkey(agentPubkey);
  const owner = getPublicKey(sk);
  if (owner === agent) throw new Error('owner and agent keys must differ');
  const content = {
    v: 1,
    type: 'beamhop-agent-attestation',
    agent: npubEncode(agent),
    owner: npubEncode(owner),
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.revoked ? { revoked: true } : {}),
  };
  return finalizeEvent(
    {
      kind: ATTESTATION_KIND,
      created_at: opts.createdAt ?? nowSec(),
      tags: [
        ['d', attestationD(agent)],
        ['p', agent],
        ['t', 'beamhop-attestation'],
        ['alt', `beamhop: ${npubEncode(owner)} operates AI agent ${npubEncode(agent)}`],
      ],
      content: JSON.stringify(content),
    },
    sk,
  );
};

export type AttestationCheck =
  | { ok: true; owner: string; agent: string; name?: string }
  | { ok: false; reason: string };

export const verifyAttestation = (
  ev: Event,
  expect: { agentPubkey?: string; ownerPubkey?: string } = {},
): AttestationCheck => {
  const clean: Event = {
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    kind: ev.kind,
    tags: ev.tags,
    content: ev.content,
    sig: ev.sig,
  };
  if (clean.kind !== ATTESTATION_KIND) return { ok: false, reason: 'wrong kind' };
  if (!verifyEvent(clean)) return { ok: false, reason: 'bad signature' };
  const d = tagValue(clean.tags, 'd');
  const m = d ? /^beamhop-agent:([0-9a-f]{64})$/.exec(d) : null;
  if (!m) return { ok: false, reason: 'bad d tag' };
  const agent = m[1]!;
  if (tagValue(clean.tags, 'p') !== agent) return { ok: false, reason: 'p tag does not match d tag' };
  let body: { type?: string; agent?: string; owner?: string; name?: string; revoked?: boolean };
  try {
    body = JSON.parse(clean.content);
  } catch {
    return { ok: false, reason: 'content is not JSON' };
  }
  if (body.type !== 'beamhop-agent-attestation') return { ok: false, reason: 'wrong content type' };
  try {
    if (!body.agent || decodePubkey(body.agent) !== agent)
      return { ok: false, reason: 'content agent mismatch' };
    if (!body.owner || decodePubkey(body.owner) !== clean.pubkey)
      return { ok: false, reason: 'content owner mismatch' };
  } catch {
    return { ok: false, reason: 'invalid keys in content' };
  }
  if (body.revoked) return { ok: false, reason: 'revoked' };
  if (clean.pubkey === agent) return { ok: false, reason: 'self-attestation' };
  if (expect.agentPubkey && decodePubkey(expect.agentPubkey) !== agent)
    return { ok: false, reason: 'unexpected agent' };
  if (expect.ownerPubkey && decodePubkey(expect.ownerPubkey) !== clean.pubkey)
    return { ok: false, reason: 'unexpected owner' };
  return { ok: true, owner: clean.pubkey, agent, ...(body.name ? { name: body.name } : {}) };
};

// ───────────────────────────── NIP-89 capability card ─────────────────────────────

export interface CapabilityCardInput {
  /** Agent hex/npub. */
  agentPubkey: string;
  owner: string;
  name: string;
  about?: string;
  picture?: string;
  /** NIP-90 request kinds accepted (5000–5999). */
  jobKinds: number[];
  /** Free-form capability labels, e.g. "code-review". */
  capabilities?: string[];
  /** d-tag identifier (default "beamhop"). */
  identifier?: string;
}

/** NIP-89 handler information (kind 31990) listing supported NIP-90 job kinds (§6A.6). */
export const buildCapabilityCard = (input: CapabilityCardInput): EventTemplate => {
  const agent = decodePubkey(input.agentPubkey);
  const owner = decodePubkey(input.owner);
  for (const k of input.jobKinds) {
    if (!Number.isInteger(k) || k < 5000 || k > 5999) throw new Error(`invalid NIP-90 job kind ${k}`);
  }
  const tags: string[][] = [
    ['d', input.identifier ?? 'beamhop'],
    ...[...new Set(input.jobKinds)].sort((a, b) => a - b).map((k) => ['k', String(k)]),
    ['p', owner, '', 'owner'],
    ['a', `${ATTESTATION_KIND}:${owner}:${attestationD(agent)}`, '', 'attestation'],
    ['t', 'beamhop'],
    ['t', 'ai-agent'],
    ...(input.capabilities ?? []).map((c) => ['t', c]),
  ];
  const content: Record<string, unknown> = {
    name: input.name,
    about: input.about ?? `AI agent operated by ${npubEncode(owner)}`,
    bot: true,
  };
  if (input.picture) content.picture = input.picture;
  return { kind: CAPABILITY_CARD_KIND, created_at: nowSec(), tags, content: JSON.stringify(content) };
};

export const parseCapabilityCard = (
  ev: Event,
): { agent: string; owner?: string; jobKinds: number[]; name?: string; capabilities: string[] } | null => {
  if (ev.kind !== CAPABILITY_CARD_KIND) return null;
  const jobKinds = ev.tags
    .filter((t) => t[0] === 'k')
    .map((t) => Number(t[1]))
    .filter((k) => Number.isInteger(k) && k >= 5000 && k <= 5999);
  const owner = ev.tags.find((t) => t[0] === 'p' && t[3] === 'owner')?.[1];
  let name: string | undefined;
  try {
    name = (JSON.parse(ev.content) as { name?: string }).name;
  } catch {
    // ignore
  }
  const capabilities = ev.tags
    .filter((t) => t[0] === 't' && t[1] !== 'beamhop' && t[1] !== 'ai-agent')
    .map((t) => t[1]!);
  return { agent: ev.pubkey, ...(owner ? { owner } : {}), jobKinds, ...(name ? { name } : {}), capabilities };
};

// ───────────────────────────── NIP-05 ─────────────────────────────

const NIP05_NAME = /^[a-z0-9._-]+$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export interface Nip05Entry {
  name: string;
  pubkey: string;
  relays?: string[];
}

export interface Nip05Bundle {
  domain: string;
  path: '/.well-known/nostr.json';
  json: { names: Record<string, string>; relays?: Record<string, string[]> };
  /** Pretty-printed file body. */
  body: string;
  handles: string[];
  snippets: { static: string; nginx: string; cloudflarePages: string };
}

/** Build `.well-known/nostr.json` content + hosting snippets for the owner's domain (§4). */
export const buildNip05Json = (domain: string, names: Nip05Entry[] | Record<string, string>): Nip05Bundle => {
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!DOMAIN.test(d)) throw new Error(`invalid domain: ${domain}`);
  const entries: Nip05Entry[] = Array.isArray(names)
    ? names
    : Object.entries(names).map(([name, pubkey]) => ({ name, pubkey }));
  if (!entries.length) throw new Error('at least one name is required');
  const json: Nip05Bundle['json'] = { names: {} };
  for (const e of entries) {
    const n = e.name.trim().toLowerCase();
    if (!NIP05_NAME.test(n)) throw new Error(`invalid NIP-05 name: ${e.name} (use a-z 0-9 . _ -)`);
    if (json.names[n]) throw new Error(`duplicate NIP-05 name: ${n}`);
    const pk = decodePubkey(e.pubkey);
    json.names[n] = pk;
    if (e.relays?.length) {
      json.relays ??= {};
      json.relays[pk] = e.relays;
    }
  }
  const body = `${JSON.stringify(json, null, 2)}\n`;
  const snippets = {
    static: [
      `# Upload the file to your web root so it is served at https://${d}/.well-known/nostr.json`,
      `mkdir -p .well-known && cp nostr.json .well-known/nostr.json`,
      `# The response must be JSON and send:  Access-Control-Allow-Origin: *`,
      `# Do not redirect this URL (NIP-05 clients ignore redirects).`,
    ].join('\n'),
    nginx: [
      `server {`,
      `  server_name ${d};`,
      `  location = /.well-known/nostr.json {`,
      `    alias /var/www/${d}/.well-known/nostr.json;`,
      `    default_type application/json;`,
      `    add_header Access-Control-Allow-Origin "*" always;`,
      `  }`,
      `}`,
    ].join('\n'),
    cloudflarePages: [
      `# Put nostr.json at public/.well-known/nostr.json and add this to public/_headers:`,
      `/.well-known/nostr.json`,
      `  Access-Control-Allow-Origin: *`,
      `  Content-Type: application/json`,
    ].join('\n'),
  };
  return {
    domain: d,
    path: '/.well-known/nostr.json',
    json,
    body,
    handles: Object.keys(json.names).map((n) => `${n}@${d}`),
    snippets,
  };
};

export type Nip05Fetch = (
  url: string,
  init?: { headers?: Record<string, string>; redirect?: 'manual' | 'follow' | 'error'; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type Nip05Check =
  | { ok: true; pubkey: string; relays?: string[] }
  | { ok: false; reason: string; pubkey?: string };

/** Resolve a NIP-05 handle (`name@domain` or `domain`). Redirects are not followed (NIP-05). */
export const checkNip05 = async (
  handle: string,
  opts: { expectedPubkey?: string; fetch?: Nip05Fetch; timeoutMs?: number } = {},
): Promise<Nip05Check> => {
  const h = handle.trim().toLowerCase();
  const at = h.lastIndexOf('@');
  const name = at === -1 ? '_' : h.slice(0, at) || '_';
  const domain = at === -1 ? h : h.slice(at + 1);
  if (!NIP05_NAME.test(name) || !DOMAIN.test(domain)) return { ok: false, reason: 'invalid handle' };
  const f = opts.fetch ?? (globalThis.fetch as unknown as Nip05Fetch);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await f(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: ac.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { names?: Record<string, string>; relays?: Record<string, string[]> };
    const pk = body?.names?.[name];
    if (typeof pk !== 'string' || !/^[0-9a-f]{64}$/.test(pk)) return { ok: false, reason: 'name not found' };
    if (opts.expectedPubkey && decodePubkey(opts.expectedPubkey) !== pk)
      return { ok: false, reason: 'pubkey mismatch', pubkey: pk };
    const relays = body.relays?.[pk];
    return { ok: true, pubkey: pk, ...(Array.isArray(relays) ? { relays } : {}) };
  } catch (err) {
    return { ok: false, reason: (err as Error).name === 'AbortError' ? 'timeout' : String(err) };
  } finally {
    clearTimeout(timer);
  }
};
