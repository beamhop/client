import type { ChannelContext, ChannelPlugin } from '@beamhop/core';
import { connectTelegram, type TelegramConn, type TelegramConnOptions } from './conn.ts';
import { createSetupWizard } from './wizard.ts';

export * from './api.ts';
export * from './conn.ts';
export * from './format.ts';
export * from './normalize.ts';
export * from './ratelimit.ts';
export type * from './types.ts';
export * from './wizard.ts';

export interface TelegramPlugin extends ChannelPlugin {
  connect(ctx: ChannelContext): Promise<TelegramConn>;
}

/** Create the Telegram channel plugin; options are for tests / self-hosted Bot API servers. */
export const createTelegramPlugin = (opts: TelegramConnOptions = {}): TelegramPlugin => ({
  id: 'telegram',
  displayName: 'Telegram',
  setup: createSetupWizard({
    ...(opts.apiRoot ? { apiRoot: opts.apiRoot } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  }),
  connect: (ctx) => connectTelegram(ctx, opts),
});

export const telegramPlugin: TelegramPlugin = createTelegramPlugin();
export default telegramPlugin;
