import { type ChannelContext, type InboundMsg, type KV, silentLogger } from '@beamhop/core';

export const memoryKV = (): KV & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(k: string) {
      return data.get(k) as T | undefined;
    },
    async set(k, v) {
      data.set(k, v);
    },
    async delete(k) {
      data.delete(k);
    },
  };
};

export const makeCtx = (
  settings: Record<string, unknown>,
  nsec: string,
  state: KV = memoryKV(),
): ChannelContext => ({
  name: 'nostr-test',
  settings: { publishDmRelays: false, ...settings },
  secrets: { nsec },
  log: silentLogger,
  state,
});

/** Collect inbound messages in the background. */
export const collect = (iter: AsyncIterable<InboundMsg>): InboundMsg[] => {
  const out: InboundMsg[] = [];
  (async () => {
    for await (const m of iter) out.push(m);
  })();
  return out;
};
