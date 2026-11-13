/**
 * SSRF-safe host-side fetch (§7A "downloads only through the broker", review wave B SSRF-1).
 *
 * The daemon runs outside the sandbox, so any URL it fetches on behalf of a channel user or an
 * agent must not reach loopback, link-local (cloud metadata), private, CGNAT or other special
 * networks. DNS is resolved here, every returned address is checked, and the connection goes to
 * the checked IP (the host name is kept for SNI, certificate checks and the Host header), so a
 * second DNS answer cannot rebind it. Redirects are followed manually and re-checked per hop.
 * Bodies are size-limited and the whole request is time-limited.
 */
import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { BeamhopError } from '@beamhop/core';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type LookupAll = (host: string) => Promise<ResolvedAddress[]>;

export interface SafeFetchOptions {
  /** DNS resolver returning every address (default: `dns.lookup(host, { all: true })`). */
  lookup?: LookupAll;
  /** Address filter (default: `isBlockedAddress`). Tests may allow a specific loopback port. */
  isBlocked?: (address: string) => boolean;
  /** Max response body bytes (default 25 MiB). */
  maxBytes?: number;
  /** Overall time limit including redirects (default 30 s). */
  timeoutMs?: number;
  /** Max redirects (default 5). */
  maxRedirects?: number;
  /** Ports allowed (default 80, 443, 8080, 8443). Empty array = any port. */
  allowedPorts?: number[];
  userAgent?: string;
}

export interface SafeFetchCallOptions {
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface SafeFetcher {
  /** GET `url`; resolves to a buffered `Response` (body ≤ maxBytes). */
  fetch(url: string, opts?: SafeFetchCallOptions): Promise<Response>;
  /** GET `url` into `dest` (atomic write, mode 0600). Returns the byte count. */
  download(url: string, dest: string, opts?: SafeFetchCallOptions): Promise<number>;
}

// ───────────────────────────── address classification ─────────────────────────────

const v4ToInt = (ip: string): number => {
  const p = ip.split('.').map(Number);
  return (((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!) >>> 0;
};

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

const V4_RANGES = V4_BLOCKS.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (v4ToInt(base) & mask) >>> 0, mask };
});

const isBlockedV4 = (ip: string): boolean => {
  const n = v4ToInt(ip);
  return V4_RANGES.some((r) => (n & r.mask) >>> 0 === r.net);
};

/** Expand an IPv6 address to 8 16-bit groups (handles `::` and a trailing dotted IPv4). */
const v6Groups = (ip: string): number[] | undefined => {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    if (isIP(last) !== 4) return undefined;
    const n = v4ToInt(last);
    tail = [n >>> 16, n & 0xffff];
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const [head, rest] = s.includes('::') ? s.split('::') : [s, undefined];
  const parse = (part: string | undefined) => (part ? part.split(':').filter((x) => x !== '') : []);
  const h = parse(head).map((x) => Number.parseInt(x, 16));
  const r = parse(rest).map((x) => Number.parseInt(x, 16));
  const fill = 8 - h.length - r.length - tail.length;
  if (rest === undefined && fill !== 0) return undefined;
  if (fill < 0) return undefined;
  const out = [...h, ...new Array(rest === undefined ? 0 : fill).fill(0), ...r, ...tail];
  if (out.length !== 8 || out.some((g) => !Number.isFinite(g) || g < 0 || g > 0xffff)) return undefined;
  return out;
};

const groupsToV4 = (a: number, b: number): string => [a >>> 8, a & 0xff, b >>> 8, b & 0xff].join('.');

const isBlockedV6 = (ip: string): boolean => {
  const g = v6Groups(ip);
  if (!g) return true; // unparseable: fail closed
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (g.every((x) => x === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1)
    return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, IPv4-translated ::ffff:0:a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0) {
    if ((g4 === 0 && g5 === 0xffff) || (g4 === 0 && g5 === 0) || (g4 === 0xffff && g5 === 0))
      return isBlockedV4(groupsToV4(g6, g7));
    return true; // other ::/64 forms are not routable unicast
  }
  if (g0 === 0x64 && g1 === 0xff9b) return isBlockedV4(groupsToV4(g6, g7)); // NAT64 64:ff9b::/96 (+ /48 local)
  if (g0 === 0x2002) return isBlockedV4(groupsToV4(g1, g2)); // 6to4 embeds an IPv4
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo (embeds an obfuscated IPv4)
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // documentation
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard-only
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7 (incl. fd00:ec2::254 metadata)
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
};

/** Is this IP literal loopback, link-local, private, metadata, multicast or otherwise special? */
export const isBlockedAddress = (address: string): boolean => {
  const fam = isIP(address);
  if (fam === 4) return isBlockedV4(address);
  if (fam === 6) return isBlockedV6(address);
  return true;
};

// ───────────────────────────── fetch ─────────────────────────────

const defaultLookup: LookupAll = async (host) => {
  const { lookup } = await import('node:dns/promises');
  const res = await lookup(host, { all: true, verbatim: true });
  return res.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

const DEFAULT_PORTS = [80, 443, 8080, 8443];

const refuse = (msg: string) => new BeamhopError('forbidden', `fetch refused: ${msg}`);

export const createSafeFetch = (opts: SafeFetchOptions = {}): SafeFetcher => {
  const lookup = opts.lookup ?? defaultLookup;
  const isBlocked = opts.isBlocked ?? isBlockedAddress;
  const maxBytesDefault = opts.maxBytes ?? 25 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const ports = opts.allowedPorts ?? DEFAULT_PORTS;

  /** Validate a URL and resolve it to one checked address. */
  const resolve = async (raw: string): Promise<{ url: URL; address: ResolvedAddress }> => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BeamhopError('invalid_input', 'fetch refused: invalid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refuse(`scheme ${url.protocol}`);
    if (url.username || url.password) throw refuse('credentials in URL');
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (ports.length && !ports.includes(port)) throw refuse(`port ${port}`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host) throw refuse('empty host');
    let addrs: ResolvedAddress[];
    if (isIP(host)) addrs = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
    else {
      try {
        addrs = await lookup(host);
      } catch {
        throw new BeamhopError('unavailable', `fetch failed: cannot resolve ${host}`);
      }
    }
    if (!addrs.length) throw new BeamhopError('unavailable', `fetch failed: cannot resolve ${host}`);
    // Every address must be public: a mixed answer is how DNS rebinding hides a private target.
    for (const a of addrs) if (isBlocked(a.address)) throw refuse(`${host} resolves to a blocked address`);
    return { url, address: addrs[0]! };
  };

  const once = (url: URL, address: ResolvedAddress, signal: AbortSignal): Promise<IncomingMessage> =>
    new Promise((res, rej) => {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const isHttps = url.protocol === 'https:';
      const req = (isHttps ? httpsRequest : httpRequest)({
        host: address.address,
        family: address.family,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          Host: url.host,
          'User-Agent': opts.userAgent ?? 'beamhop-fetch',
          Accept: '*/*',
          'Accept-Encoding': 'identity',
        },
        // SNI + certificate verification against the original host name (not for IP literals).
        ...(isHttps && !isIP(host) ? { servername: host } : {}),
        agent: false,
        signal,
      });
      req.on('response', res);
      req.on('error', rej);
      req.end();
    });

  const get = async (
    raw: string,
    call: SafeFetchCallOptions,
  ): Promise<{ res: IncomingMessage; signal: AbortSignal; cleanup: () => void; maxBytes: number }> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new BeamhopError('timeout', 'fetch timed out')), timeoutMs);
    timer.unref?.();
    const onAbort = () => ac.abort(call.signal?.reason);
    call.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      call.signal?.removeEventListener('abort', onAbort);
    };
    try {
      let current = raw;
      for (let hop = 0; ; hop++) {
        const { url, address } = await resolve(current);
        const res = await once(url, address, ac.signal);
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (hop >= maxRedirects) throw refuse('too many redirects');
          current = new URL(res.headers.location, url).toString();
          continue;
        }
        return { res, signal: ac.signal, cleanup, maxBytes: call.maxBytes ?? maxBytesDefault };
      }
    } catch (e) {
      cleanup();
      if (ac.signal.aborted && ac.signal.reason instanceof BeamhopError) throw ac.signal.reason;
      throw e;
    }
  };

  const tooLarge = (max: number) => new BeamhopError('invalid_input', `download exceeds ${max} bytes`);

  /** Iterate the body, enforcing the size limit (header and streamed). */
  async function* body(res: IncomingMessage, max: number): AsyncGenerator<Buffer> {
    const len = Number(res.headers['content-length'] ?? 0);
    if (Number.isFinite(len) && len > max) {
      res.destroy();
      throw tooLarge(max);
    }
    let size = 0;
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > max) {
        res.destroy();
        throw tooLarge(max);
      }
      yield chunk;
    }
  }

  const wrapAbort = (e: unknown, signal: AbortSignal): unknown =>
    signal.aborted && signal.reason instanceof BeamhopError ? signal.reason : e;

  return {
    async fetch(url, call = {}) {
      const { res, signal, cleanup, maxBytes } = await get(url, call);
      try {
        const chunks: Buffer[] = [];
        for await (const c of body(res, maxBytes)) chunks.push(c);
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
        }
        const status = res.statusCode ?? 500;
        const nullBody = status === 204 || status === 304 || (status >= 100 && status < 200);
        return new Response(nullBody ? null : Buffer.concat(chunks), {
          status: status < 200 || status > 599 ? 502 : status,
          ...(res.statusMessage ? { statusText: res.statusMessage } : {}),
          headers,
        });
      } catch (e) {
        throw wrapAbort(e, signal);
      } finally {
        cleanup();
      }
    },
    async download(url, dest, call = {}) {
      const { res, signal, cleanup, maxBytes } = await get(url, call);
      const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
      try {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          throw new BeamhopError('unavailable', `download failed: HTTP ${status}`);
        }
        const out = createWriteStream(tmp, { mode: 0o600 });
        let size = 0;
        try {
          for await (const c of body(res, maxBytes)) {
            size += c.length;
            if (!out.write(c)) await new Promise<void>((r) => out.once('drain', () => r()));
          }
        } finally {
          await new Promise<void>((r) => out.end(() => r()));
        }
        await rename(tmp, dest);
        return size;
      } catch (e) {
        await unlink(tmp).catch(() => {});
        throw wrapAbort(e, signal);
      } finally {
        cleanup();
      }
    },
  };
};
