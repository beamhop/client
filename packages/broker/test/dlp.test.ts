import { describe, expect, it } from 'vitest';
import { applyDlp, entropy, scanOutbound } from '../src/index.ts';

// Fake tokens are assembled at runtime so no secret-shaped literal sits in the repo.
const rnd = (alphabet: string, n: number, seed = 7) => {
  let s = '';
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += alphabet[x % alphabet.length];
  }
  return s;
};
const AZ09 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const alnum = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const b32 = '023456789acdefghjklmnpqrstuvwxyz';
const hex = '0123456789abcdef';

const P = {
  aws: `AKIA${rnd(AZ09, 16)}`,
  awsSecret: `aws_secret_access_key = ${rnd(`${alnum}/+`, 40, 3)}`,
  ghp: `ghp_${rnd(alnum, 36)}`,
  ghs: `ghs_${rnd(alnum, 36, 9)}`,
  ghpat: `github_pat_${rnd(alnum, 22)}_${rnd(alnum, 59, 5)}`,
  slack: `xoxb-${rnd('0123456789', 12)}-${rnd('0123456789', 12, 2)}-${rnd(alnum, 24)}`,
  slackHook: `https://hooks.slack.com/services/T${rnd(AZ09, 8)}/B${rnd(AZ09, 8)}/${rnd(alnum, 24)}`,
  openai: `sk-proj-${rnd(`${alnum}_-`, 48)}`,
  openaiLegacy: `sk-${rnd(alnum, 48, 11)}`,
  anthropic: `sk-ant-api03-${rnd(`${alnum}_-`, 93)}AA`,
  openrouter: `sk-or-v1-${rnd(hex, 64)}`,
  // Headers are split so scripts/check-no-secrets.mjs does not flag this file (wave C SCAN-1).
  pem: `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\n${rnd(alnum, 64)}\n${rnd(alnum, 64, 3)}\n-----END OPENSSH PRIVATE KEY-----`,
  rsa: `-----BEGIN RSA ${'PRIVATE'} KEY-----\n${rnd(alnum, 64)}\n-----END RSA PRIVATE KEY-----`,
  jwt: `eyJ${rnd(alnum, 20)}.eyJ${rnd(alnum, 40, 4)}.${rnd(`${alnum}_-`, 43, 8)}`,
  telegram: `${rnd('123456789', 10)}:AA${rnd(`${alnum}_-`, 33)}`,
  nsec: `nsec1${rnd(b32, 58)}`,
  google: `AIza${rnd(`${alnum}_-`, 35)}`,
  stripe: `sk_live_${rnd(alnum, 24)}`,
  npm: `npm_${rnd(alnum, 36)}`,
  generic: `DB_PASSWORD="${rnd(alnum, 24, 13)}"`,
  genericJson: `{"api_key": "${rnd(alnum, 32, 17)}"}`,
  urlCreds: `postgres://admin:${rnd(alnum, 16, 21)}@db.internal:5432/app`,
};

describe('scanOutbound — positives', () => {
  const expected: Record<keyof typeof P, string> = {
    aws: 'aws-access-key-id',
    awsSecret: 'aws-secret-access-key',
    ghp: 'github-token',
    ghs: 'github-token',
    ghpat: 'github-fine-grained-pat',
    slack: 'slack-token',
    slackHook: 'slack-webhook',
    openai: 'openai-api-key',
    openaiLegacy: 'openai-api-key',
    anthropic: 'anthropic-api-key',
    openrouter: 'openrouter-api-key',
    pem: 'private-key',
    rsa: 'private-key',
    jwt: 'jwt',
    telegram: 'telegram-bot-token',
    nsec: 'nostr-nsec',
    google: 'google-api-key',
    stripe: 'stripe-key',
    npm: 'npm-token',
    generic: 'generic-secret',
    genericJson: 'generic-secret',
    urlCreds: 'url-credentials',
  };
  for (const [name, type] of Object.entries(expected)) {
    it(`${name} → ${type}`, () => {
      const value = P[name as keyof typeof P];
      const text = `Here you go: ${value} — cheers`;
      const r = scanOutbound(text);
      expect(r.findings.map((f) => f.type)).toContain(type);
      expect(r.redacted).toContain(`[REDACTED:${type}]`);
      expect(r.redacted).toContain('Here you go: ');
      expect(r.redacted).toContain(' — cheers');
    });
  }

  it('reports exact index/length', () => {
    const text = `token ${P.ghp} end`;
    const [f] = scanOutbound(text).findings;
    expect(f).toEqual({ type: 'github-token', index: 6, length: P.ghp.length });
    expect(text.slice(f!.index, f!.index + f!.length)).toBe(P.ghp);
  });

  it('generic assignment redacts only the value', () => {
    const r = scanOutbound(P.generic);
    expect(r.redacted).toBe('DB_PASSWORD="[REDACTED:generic-secret]"');
  });

  it('finds multiple secrets and does not double-redact overlaps', () => {
    const text = `a=${P.aws} b=${P.anthropic}\nGITHUB_TOKEN=${P.ghp}`;
    const r = scanOutbound(text);
    expect(r.findings).toHaveLength(3);
    expect(r.redacted).not.toContain(P.aws);
    expect(r.redacted).not.toContain(P.anthropic);
    expect(r.redacted).not.toContain(P.ghp);
    expect(r.redacted.match(/REDACTED/g)).toHaveLength(3);
  });

  it('anthropic keys are not misclassified as openai', () => {
    const types = scanOutbound(P.anthropic).findings.map((f) => f.type);
    expect(types).toEqual(['anthropic-api-key']);
  });

  it('truncated private key block is still caught', () => {
    const r = scanOutbound(`-----BEGIN ${'PRIVATE'} KEY-----\n${rnd(alnum, 40)}`);
    expect(r.findings[0]?.type).toBe('private-key');
  });

  it('known secret values match exactly, anywhere, every occurrence', () => {
    const known = 'hunter2-but-longer';
    const r = scanOutbound(`x${known}y and again ${known}`, [known]);
    expect(r.findings.filter((f) => f.type === 'known-secret')).toHaveLength(2);
    expect(r.redacted).toBe('x[REDACTED:known-secret]y and again [REDACTED:known-secret]');
  });

  it('a known value overlapping a pattern match is reported as known-secret', () => {
    const r = scanOutbound(`key: ${P.openrouter}`, [P.openrouter]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.type).toBe('known-secret');
  });
});

describe('scanOutbound — negatives', () => {
  const clean = [
    'Hello! The build passed and all 42 tests are green.',
    'Use the `sk-` prefix for OpenAI keys; never paste them here.',
    'password = "changeme"',
    `token: \${GITHUB_TOKEN}`,
    'API_KEY=<your-key-here>',
    'secret_name = "ANTHROPIC_API_KEY"',
    'commit 3b8fb9c Revise plan: Node/TS + srt',
    'sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'uuid 123e4567-e89b-12d3-a456-426614174000',
    'Call me at 12:30, ok? Meeting id 123456:abc',
    'ghp_short',
    'xoxb-not-a-token',
    'AKIA lowercase akiaabcdefghijklmnop',
    'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    'https://example.com/path?x=1&y=2',
    'The function getAccessToken() returns a promise.',
    'password_reset_url = "https://example.com/reset"',
    'tokens: 1234, outputTokens: 5678',
    'eyJhbGciOiJIUzI1NiJ9 alone is just a header',
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA is a public key fragment',
  ];
  for (const text of clean) {
    it(JSON.stringify(text.slice(0, 50)), () => {
      const r = scanOutbound(text);
      expect(r.findings).toEqual([]);
      expect(r.redacted).toBe(text);
    });
  }

  it('ignores very short known secrets (avoid redacting common words)', () => {
    expect(scanOutbound('the cat sat', ['cat']).findings).toEqual([]);
  });
});

describe('applyDlp', () => {
  const text = `here: ${P.ghp}`;
  it('block', () => {
    const r = applyDlp('block', text);
    expect(r.ok).toBe(false);
    expect(r.action).toBe('blocked');
    expect(r.text).not.toContain(P.ghp);
  });
  it('redact', () => {
    const r = applyDlp('redact', text);
    expect(r).toMatchObject({ ok: true, action: 'redacted', text: 'here: [REDACTED:github-token]' });
  });
  it('warn keeps text', () => {
    const r = applyDlp('warn', text);
    expect(r).toMatchObject({ ok: true, action: 'warned', text });
    expect(r.findings).toHaveLength(1);
  });
  it('clean passes in every mode', () => {
    for (const m of ['block', 'redact', 'warn'] as const) {
      expect(applyDlp(m, 'all good')).toEqual({ ok: true, text: 'all good', findings: [], action: 'pass' });
    }
  });
});

describe('entropy', () => {
  it('orders random above repetitive', () => {
    expect(entropy('aaaaaaaa')).toBe(0);
    expect(entropy(rnd(alnum, 32))).toBeGreaterThan(4);
  });
});

// docs/security/REVIEW-wave-a.md — DLP-1/DLP-2: cheap obfuscations of a secret must still be caught.
describe('DLP obfuscation resistance', () => {
  const known = `vault-${rnd(alnum, 32, 21)}`;
  const zw = (s: string, ch = '​') => [...s].join(ch);
  const fullwidth = (s: string) =>
    [...s]
      .map((c) => (/[A-Za-z0-9]/.test(c) ? String.fromCodePoint((c.codePointAt(0) ?? 0) + 0xfee0) : c))
      .join('');

  it('DLP-1: catches a pattern secret with zero-width / invisible chars interleaved', () => {
    for (const ch of ['​', '‌', '‍', '⁠', '﻿', '­']) {
      const r = scanOutbound(`here: ${zw(P.ghp, ch)} done`);
      expect(r.findings.map((f) => f.type)).toContain('github-token');
      expect(r.redacted).toBe('here: [REDACTED:github-token] done');
    }
  });

  it('DLP-1: catches a known secret with zero-width chars and fullwidth (NFKC) forms', () => {
    for (const text of [`x ${zw(known)} y`, `x ${fullwidth(known)} y`]) {
      const r = scanOutbound(text, [known]);
      expect(r.findings).toHaveLength(1);
      expect(r.redacted).toBe('x [REDACTED:known-secret] y');
    }
  });

  it('DLP-2: catches base64 / base64url / hex encodings of a known secret, at any alignment', () => {
    const b = Buffer.from(known);
    const cases = [
      b.toString('base64'),
      b.toString('base64url'),
      b.toString('hex'),
      b.toString('hex').toUpperCase(),
      Buffer.concat([Buffer.from('a'), b]).toString('base64'),
      Buffer.concat([Buffer.from('ab'), b, Buffer.from('trailer')]).toString('base64'),
      Buffer.from(`token=${known}\n`).toString('base64'),
    ];
    for (const enc of cases) {
      const r = applyDlp('block', `payload ${enc} end`, [known]);
      expect(r.ok, enc).toBe(false);
      expect(r.text).not.toContain(enc);
    }
  });

  it('DLP-2: catches base64 of a pattern secret (e.g. a GitHub token)', () => {
    const enc = Buffer.from(`GITHUB_TOKEN=${P.ghp}`).toString('base64');
    const r = scanOutbound(`see ${enc}`);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.redacted).not.toContain(enc);
  });

  it('does not flag ordinary base64 / hex / unicode text', () => {
    const plain = Buffer.from('hello world, this is just a normal sentence about cats.').toString('base64');
    expect(scanOutbound(`img ${plain} and sha ${rnd(hex, 40)} — naïve café 日本語`).findings).toEqual([]);
  });
});
