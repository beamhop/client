import { BeamhopError, type ErrorCode, type Logger, silentLogger } from '@beamhop/core';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  provider: string;
  baseUrl: string;
  /** Provider API token. Only ever placed in the auth header; scrubbed from errors. */
  token: string;
  /** Build auth headers; default `Authorization: Bearer <token>`. */
  auth?: (token: string) => Record<string, string>;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Retries for 429 (all methods) and 5xx/network errors (idempotent methods only). Default 3. */
  maxRetries?: number;
  /** Upper bound for a single back-off wait. Default 60 s. */
  maxBackoffMs?: number;
  log?: Logger;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Return `undefined` instead of throwing on 404 (lookups, idempotent deletes). */
  allow404?: boolean;
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

const statusCode = (status: number): ErrorCode => {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'invalid_input';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'unavailable';
  return 'internal';
};

/** Pull a human message out of the various provider error envelopes. */
export const providerMessage = (body: unknown): { message?: string; code?: string } => {
  if (!body || typeof body !== 'object') return typeof body === 'string' && body ? { message: body } : {};
  const b = body as Record<string, unknown>;
  // Hetzner: { error: { code, message } }
  if (b.error && typeof b.error === 'object') {
    const e = b.error as Record<string, unknown>;
    return { message: String(e.message ?? ''), code: e.code ? String(e.code) : undefined };
  }
  // Fly: { error: "..." }
  if (typeof b.error === 'string') return { message: b.error };
  // GraphQL: { errors: [{ message }] }
  if (Array.isArray(b.errors) && b.errors.length) {
    const e = b.errors[0] as Record<string, unknown>;
    return { message: String(e.message ?? '') };
  }
  // DigitalOcean: { id, message }; Render: { id?, message }
  if (typeof b.message === 'string') return { message: b.message, code: b.id ? String(b.id) : undefined };
  return {};
};

/** Seconds/epoch → milliseconds to wait, from Retry-After or provider RateLimit-Reset headers. */
export const backoffFromHeaders = (h: Headers, nowMs: number): number | undefined => {
  const ra = h.get('retry-after');
  if (ra) {
    const s = Number(ra);
    if (Number.isFinite(s)) return Math.max(0, s * 1000);
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, d - nowMs);
  }
  // Hetzner (RateLimit-Reset) and DigitalOcean (ratelimit-reset) send a unix timestamp.
  const reset = h.get('ratelimit-reset') ?? h.get('x-ratelimit-reset');
  if (reset) {
    const n = Number(reset);
    if (Number.isFinite(n)) return n > 1e9 ? Math.max(0, n * 1000 - nowMs) : Math.max(0, n * 1000);
  }
  return undefined;
};

export class HttpClient {
  private readonly o: Required<Omit<HttpClientOptions, 'auth' | 'log'>> & Pick<HttpClientOptions, 'auth'>;
  private readonly log: Logger;

  constructor(opts: HttpClientOptions) {
    this.o = {
      provider: opts.provider,
      token: opts.token,
      auth: opts.auth,
      fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      maxRetries: opts.maxRetries ?? 3,
      maxBackoffMs: opts.maxBackoffMs ?? 60_000,
      baseUrl: opts.baseUrl.replace(/\/+$/, ''),
    };
    this.log = opts.log ?? silentLogger;
  }

  private scrub(s: string): string {
    return this.o.token ? s.split(this.o.token).join('[redacted]') : s;
  }

  async request<T = unknown>(method: string, path: string, ro: RequestOptions = {}): Promise<T> {
    const url = new URL(this.o.baseUrl + path);
    for (const [k, v] of Object.entries(ro.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'beamhop-deploy',
      ...(this.o.auth ? this.o.auth(this.o.token) : { authorization: `Bearer ${this.o.token}` }),
    };
    if (ro.body !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = {
      method,
      headers,
      body: ro.body === undefined ? undefined : JSON.stringify(ro.body),
    };

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.o.fetch(url.toString(), init);
      } catch (err) {
        if (IDEMPOTENT.has(method) && attempt < this.o.maxRetries) {
          await this.o.sleep(Math.min(this.o.maxBackoffMs, 500 * 2 ** attempt));
          continue;
        }
        throw new BeamhopError(
          'unavailable',
          `${this.o.provider}: request failed: ${this.scrub((err as Error).message ?? String(err))}`,
        );
      }

      if (res.status === 404 && ro.allow404) {
        await res.body?.cancel();
        return undefined as T;
      }
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as T;
        }
      }

      const retriable = res.status === 429 || (res.status >= 500 && IDEMPOTENT.has(method));
      if (retriable && attempt < this.o.maxRetries) {
        const wait = backoffFromHeaders(res.headers, Date.now()) ?? 500 * 2 ** attempt;
        await res.body?.cancel();
        this.log.warn('provider api retry', { provider: this.o.provider, status: res.status, attempt });
        await this.o.sleep(Math.min(this.o.maxBackoffMs, wait));
        continue;
      }

      const raw = await res.text();
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {}
      const pm = providerMessage(body);
      const code = statusCode(res.status);
      const hint =
        code === 'unauthorized' || code === 'forbidden'
          ? ` (check the token stored as deploy.${this.o.provider}.token)`
          : code === 'rate_limited'
            ? ' (provider rate limit; try again later)'
            : '';
      throw new BeamhopError(
        code,
        this.scrub(
          `${this.o.provider}: ${method} ${path} → ${res.status}${pm.message ? `: ${pm.message}` : ''}${hint}`,
        ),
        {
          status: res.status,
          providerCode: pm.code,
          retryAfterMs: backoffFromHeaders(res.headers, Date.now()),
        },
      );
    }
  }

  get<T = unknown>(path: string, ro?: RequestOptions) {
    return this.request<T>('GET', path, ro);
  }
  post<T = unknown>(path: string, body?: unknown, ro?: RequestOptions) {
    return this.request<T>('POST', path, { ...ro, body });
  }
  delete<T = unknown>(path: string, ro?: RequestOptions) {
    return this.request<T>('DELETE', path, ro);
  }
}

/** Minimal GraphQL client on top of HttpClient (Railway). GraphQL errors arrive with HTTP 200. */
export class GraphQLClient {
  constructor(
    private readonly http: HttpClient,
    private readonly path: string,
    private readonly provider: string,
  ) {}

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.http.post<{
      data?: T;
      errors?: { message: string; extensions?: { code?: string } }[];
    }>(this.path, { query, variables });
    if (res?.errors?.length) {
      const msg = res.errors.map((e) => e.message).join('; ');
      const ext = res.errors[0]?.extensions?.code ?? '';
      const code: ErrorCode = /not authori[sz]ed|unauthori[sz]ed|UNAUTHENTICATED/i.test(msg + ext)
        ? 'unauthorized'
        : /not found/i.test(msg)
          ? 'not_found'
          : /rate.?limit/i.test(msg)
            ? 'rate_limited'
            : 'invalid_input';
      throw new BeamhopError(code, `${this.provider}: ${msg}`, { graphql: true });
    }
    if (!res?.data) throw new BeamhopError('internal', `${this.provider}: empty GraphQL response`);
    return res.data;
  }
}
