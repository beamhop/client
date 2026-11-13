/** Outbound helpers that honor HTTPS_PROXY (Node's built-in WebSocket/fetch ignore it). */
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';

const proxyUrl = (): string | undefined => process.env.HTTPS_PROXY ?? process.env.https_proxy;

let cached: typeof WebSocket | undefined;

/** A WebSocket constructor routed through $HTTPS_PROXY, or undefined when no proxy is set. */
export const proxyWebSocket = (): typeof WebSocket | undefined => {
  const url = proxyUrl();
  if (!url) return undefined;
  if (cached) return cached;
  const agent = new HttpsProxyAgent(url);
  cached = class ProxiedWebSocket extends WebSocket {
    constructor(address: string, protocols?: string | string[]) {
      super(address, protocols, { agent });
    }
  } as unknown as typeof WebSocket;
  return cached;
};
