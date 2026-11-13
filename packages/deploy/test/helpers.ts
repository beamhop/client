import { mkdtemp } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeploySpec, SecretStore } from '@beamhop/core';
import { DeployState, type ProvisioningInfo } from '../src/index.ts';

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  // biome-ignore lint/suspicious/noExplicitAny: test inspection of arbitrary JSON
  body: any;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Handler = (req: Recorded, params: Record<string, string>) => FakeResponse | Promise<FakeResponse>;

/** A real HTTP server on 127.0.0.1 that records every request and answers from route handlers. */
export class FakeApi {
  readonly requests: Recorded[] = [];
  private routes: { method: string; re: RegExp; keys: string[]; handler: Handler }[] = [];
  private server?: Server;
  baseUrl = '';

  /** Register a route; later registrations win. Path params like `/servers/:id`. */
  on(method: string, path: string, handler: Handler | FakeResponse): this {
    const keys: string[] = [];
    const re = new RegExp(
      `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_m, k) => {
        keys.push(k);
        return '([^/]+)';
      })}$`,
    );
    this.routes.unshift({
      method,
      re,
      keys,
      handler: typeof handler === 'function' ? handler : () => handler,
    });
    return this;
  }

  /** Respond with the given sequence (last one repeats). */
  seq(method: string, path: string, responses: FakeResponse[]): this {
    let i = 0;
    return this.on(method, path, () => responses[Math.min(i++, responses.length - 1)]!);
  }

  async start(prefix = ''): Promise<string> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname.slice(prefix.length) || '/';
      const rec: Recorded = {
        method: req.method ?? 'GET',
        path,
        query: url.searchParams,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      this.requests.push(rec);
      for (const r of this.routes) {
        const m = r.method === rec.method ? r.re.exec(path) : null;
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
        const out = await r.handler(rec, params);
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...out.headers });
        res.end(out.body === undefined ? '' : JSON.stringify(out.body));
        return;
      }
      res.writeHead(599, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `no fake route for ${rec.method} ${path}` }));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}${prefix}`;
    return this.baseUrl;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  calls(method: string, path?: string | RegExp): Recorded[] {
    return this.requests.filter(
      (r) =>
        r.method === method &&
        (path === undefined || (typeof path === 'string' ? r.path === path : path.test(r.path))),
    );
  }
}

export const memorySecrets = (init: Record<string, string> = {}): SecretStore => {
  const m = new Map(Object.entries(init));
  return {
    backend: 'memory',
    get: async (k) => m.get(k),
    set: async (k, v) => {
      m.set(k, v);
    },
    delete: async (k) => {
      m.delete(k);
    },
    list: async () => [...m.keys()].map((name) => ({ name })),
  };
};

export const OWNER_NPUB = `npub1${'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58)}`;
export const PROVISIONING_PUBKEY = 'a'.repeat(32) + 'b'.repeat(32);

export const provisioning = (extra: Partial<ProvisioningInfo> = {}): ProvisioningInfo => ({
  ownerNpub: OWNER_NPUB,
  provisioningPubkey: PROVISIONING_PUBKEY,
  beamhopVersion: '1.2.3',
  ...extra,
});

export const tmpState = async (): Promise<DeployState> =>
  new DeployState(join(await mkdtemp(join(tmpdir(), 'beamhop-deploy-')), 'deployments.json'));

export const spec = (provider: string, extra: Partial<DeploySpec> = {}): DeploySpec => ({
  agent: 'reviewer',
  provider,
  mode: 'new',
  harnesses: ['claude'],
  ...extra,
});

export const noSleep = async (_ms: number) => {};
