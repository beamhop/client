import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { compilePolicy, createSandbox } from '../src/index.ts';
import { hasBwrap, makeFixture, NO_BWRAP_REASON, runIn } from './helpers.ts';

// Hits the real internet (example.com). Run with: pnpm vitest run -c vitest.live.config.ts packages/sandbox
describe.skipIf(!hasBwrap)(
  `live network through srt ${hasBwrap ? '' : `— skipped: ${NO_BWRAP_REASON}`}`,
  () => {
    const fx = makeFixture();
    afterAll(() => rmSync(fx.root, { recursive: true, force: true }));
    const upstream = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    // Pass CA settings through when the host itself sits behind a TLS-terminating proxy.
    const caEnv = Object.fromEntries(
      ['CURL_CA_BUNDLE', 'SSL_CERT_FILE'].flatMap((k) =>
        process.env[k] ? [[k, process.env[k] as string]] : [],
      ),
    );

    const run = async (allow: string[]) => {
      const policy = compilePolicy('custom', [], { net: { allow } }, { home: fx.home });
      const sbx = await createSandbox(policy, {
        backend: 'srt',
        env: caEnv,
        home: fx.home,
        ...(upstream ? { parentProxy: { https: upstream, http: upstream } } : {}),
      });
      try {
        return await runIn(sbx, 'curl', [
          '-sS',
          '-m',
          '20',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          'https://example.com',
        ]);
      } finally {
        await sbx.close();
      }
    };

    it('curl https://example.com succeeds when allowlisted', async () => {
      const r = await run(['example.com']);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('200');
    });

    it('curl https://example.com is blocked when not allowlisted', async () => {
      const r = await run(['example.org']);
      expect(r.code).not.toBe(0);
    });
  },
);
