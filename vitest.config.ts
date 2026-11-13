import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/daemon/test/**/*.test.ts',
      'apps/cli/test/**/*.test.ts',
      'apps/desktop/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
    testTimeout: 20000,
    pool: 'forks',
  },
});
