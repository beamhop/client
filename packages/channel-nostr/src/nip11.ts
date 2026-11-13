// Browser-compatible.

export interface RelayInfo {
  name?: string;
  description?: string;
  pubkey?: string;
  contact?: string;
  software?: string;
  version?: string;
  supported_nips?: number[];
  limitation?: {
    max_message_length?: number;
    max_subscriptions?: number;
    max_limit?: number;
    auth_required?: boolean;
    payment_required?: boolean;
    restricted_writes?: boolean;
    min_pow_difficulty?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** ws(s):// → http(s):// for the NIP-11 document. */
export const relayHttpUrl = (relay: string): string => relay.trim().replace(/^ws(s?):\/\//i, 'http$1://');

/** Fetch a relay's NIP-11 information document. */
export const fetchRelayInfo = async (
  relay: string,
  opts: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<RelayInfo> => {
  const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await f(relayHttpUrl(relay), {
      headers: { Accept: 'application/nostr+json' },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`NIP-11 fetch ${relay}: HTTP ${res.status}`);
    const body = await res.json();
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error(`NIP-11 ${relay}: not an object`);
    const info = body as RelayInfo;
    if (info.supported_nips !== undefined && !Array.isArray(info.supported_nips)) {
      // Some relays publish a bare number; normalize.
      info.supported_nips = typeof info.supported_nips === 'number' ? [info.supported_nips] : [];
    }
    return info;
  } finally {
    clearTimeout(t);
  }
};

export const supportsNip = (info: RelayInfo, nip: number): boolean =>
  Array.isArray(info.supported_nips) && info.supported_nips.map(Number).includes(nip);
