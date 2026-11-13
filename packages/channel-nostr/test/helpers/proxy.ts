// Live-test plumbing: route WebSockets and HTTPS through $HTTPS_PROXY when one is configured
// (Node's built-in WebSocket/fetch ignore proxy env vars).
import { request } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';
import type { FetchLike } from '../../src/nip11.ts';

const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

export class LiveWebSocket extends WebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols, agent ? { agent } : {});
  }
}

export const liveFetch: FetchLike &
  ((url: string, init?: { headers?: Record<string, string>; redirect?: string }) => ReturnType<FetchLike>) = (
  url,
  init,
) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      { headers: init?.headers ?? {}, ...(agent ? { agent } : {}), timeout: 10_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body) });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
