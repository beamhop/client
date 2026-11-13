/**
 * Minimal bech32 (BIP-173) codec for Nostr public keys, so `nostr:<hex>`, `nostr:npub1…` and
 * `nostr:nostr:npub1…` all compare equal in authorization checks. No dependency on nostr-tools.
 */
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

const polymod = (values: number[]): number => {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
};

const hrpExpand = (hrp: string): number[] => [
  ...[...hrp].map((c) => c.charCodeAt(0) >>> 5),
  0,
  ...[...hrp].map((c) => c.charCodeAt(0) & 31),
];

const convertBits = (data: number[], from: number, to: number, pad: boolean): number[] | undefined => {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from !== 0) return undefined;
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) return undefined;
  return out;
};

const HEX64 = /^[0-9a-f]{64}$/;

/** Decode `npub1…` to 64-char lowercase hex; undefined when it is not a valid npub. */
export const npubToHex = (npub: string): string | undefined => {
  const s = npub.toLowerCase();
  if (s.length > 90 || !s.startsWith('npub1')) return undefined;
  const data: number[] = [];
  for (const c of s.slice(5)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return undefined;
    data.push(v);
  }
  if (data.length < 6 || polymod([...hrpExpand('npub'), ...data]) !== 1) return undefined;
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  if (bytes?.length !== 32) return undefined;
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** Encode 64-char hex as `npub1…`. */
export const hexToNpub = (hex: string): string => {
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  const data = convertBits(bytes, 8, 5, true)!;
  const mod = polymod([...hrpExpand('npub'), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `npub1${[...data, ...checksum].map((d) => CHARSET[d]).join('')}`;
};

/**
 * Canonical form of a Nostr id (`npub1…`, 64-hex, with an optional `nostr:` NIP-21 prefix):
 * the lower-case npub. Returns undefined when the id is not a recognisable public key.
 */
export const canonicalNostrId = (id: string): string | undefined => {
  let s = id.trim().toLowerCase();
  if (s.startsWith('nostr:')) s = s.slice('nostr:'.length);
  if (HEX64.test(s)) return hexToNpub(s);
  const hex = npubToHex(s);
  return hex ? hexToNpub(hex) : undefined;
};
