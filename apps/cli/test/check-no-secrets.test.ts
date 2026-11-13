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

  it('honours the per-line allow marker', () => {
    const r = scan('allow.ts', `const x = '${SAMPLES['aws-access-key-id']}'; // check-no-secrets: allow\n`);
    expect(r.status).toBe(0);
  });
});
