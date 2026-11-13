import { defineConfig } from 'vitest/config';

// Live tests hit public Nostr relays, Telegram, OpenRouter. Run with: pnpm vitest run -c vitest.live.config.ts
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.live.test.ts', 'apps/*/test/**/*.live.test.ts'],
    testTimeout: 120000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
