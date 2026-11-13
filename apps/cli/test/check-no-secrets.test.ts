import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'check-no-secrets.mjs');
const dir = mkdtempSync(join(tmpdir(), 'bh-secrets-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const scan = (name: string, text: string) => {
  const f = join(dir, name);
  writeFileSync(f, text);
  const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

// Every literal is assembled at runtime so this file never holds a token-shaped string itself.
const a = (n: number, ch = 'a') => ch.repeat(n);
const SAMPLES: Record<string, string> = {
  'github-token': ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_'),
  'github-fine-grained-pat': ['github', 'pat', `11${a(20, 'A')}`, a(59, 'b')].join('_'),
  'anthropic-key': ['sk', 'ant', 'api03', a(90, 'x')].join('-'),
  'slack-token': ['xoxb', '123456789012', '1234567890123', a(24, 'q')].join('-'),
  'digitalocean-token': ['dop', 'v1', a(64, 'f')].join('_'),
  'aws-access-key-id': ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
  'nostr-nsec': ['nsec1', a(58, 'q')].join(''),
  'telegram-bot-token': ['123456789', `AA${a(33, 'h')}`].join(':'),
  // Review wave C SCAN-1.
  'private-key-pem': ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' '),
  'npm-token': ['npm', a(36, 'Z')].join('_'),
  'google-api-key': ['AIza', a(35, 'k')].join(''),
  'gitlab-pat': ['glpat', a(20, 'g')].join('-'),
  'stripe-secret-key': ['sk', 'live', a(24, 's')].join('_'),
};

describe('scripts/check-no-secrets.mjs', () => {
  for (const [rule, value] of Object.entries(SAMPLES)) {
    it(`flags ${rule} and masks the value`, () => {
      const r = scan(`${rule}.ts`, `const x = '${value}';\n`);
      expect(r.status).toBe(1);
      expect(r.out).toContain(rule);
      expect(r.out).not.toContain(value);
    });
  }

  it('passes prose that only mentions prefixes and runtime-built fakes', () => {
    const r = scan(
      'ok.md',
      [
        'Paste the bot token (starts with `xoxb-`) and the app token (`xapp-`).',
        'Tokens look like `123456789:AA...`; keys start with ghp_ or sk-ant-.',
        "const fake = ['ghp', 'x'.repeat(36)].join('_');",
        'nsec1 keys are bech32 encoded.',
      ].join('\n'),
    );
    expect(r.out).toContain('clean');
    expect(r.status).toBe(0);
  });

  it('SCAN-1: a secret on a very long line (minified bundle) is still found', () => {
    const r = scan('bundle.js', `${'x'.repeat(30_000)};var t='${SAMPLES['npm-token']}';\n`);
    expect(r.status).toBe(1);
    expect(r.out).toContain('npm-token');
  });

  it('SCAN-1: UTF-16 text is decoded instead of skipped as binary', () => {
    const f = join(dir, 'utf16.txt');
    writeFileSync(
      f,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`k=${SAMPLES['github-token']}\n`, 'utf16le')]),
    );
    const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('github-token');
  });

  it('honours the per-line allow marker', () => {
    const r = scan('allow.ts', `const x = '${SAMPLES['aws-access-key-id']}'; // check-no-secrets: allow\n`);
    expect(r.status).toBe(0);
  });
});
