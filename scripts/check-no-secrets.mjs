#!/usr/bin/env node
// Fail if a tracked or staged file contains a token-shaped literal — the same kinds of strings GitHub
// push protection rejects. Fake secrets in tests must be built at runtime instead, e.g.
// `['ghp', 'x'.repeat(36)].join('_')` (docs/dev/CONVENTIONS.md).
//
//   node scripts/check-no-secrets.mjs            tracked files (git ls-files) + staged changes
//   node scripts/check-no-secrets.mjs --staged   only what is staged (pre-commit hook)
//   node scripts/check-no-secrets.mjs <file...>  just these files
//
// A line that really must hold such a string (it never should) can opt out with the marker
// `check-no-secrets: allow` on the same line. Matches are reported by file:line and rule, and the
// value itself is masked so the check never prints a live secret into CI logs.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = [
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}\b/ },
  { id: 'anthropic-key', re: /\bsk-ant-[a-z]{2,8}\d{0,3}-[A-Za-z0-9_-]{80,}/ },
  { id: 'openrouter-key', re: /\bsk-or-v1-[a-f0-9]{64}\b/ },
  { id: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20}T3BlbkFJ[A-Za-z0-9_-]{20,}/ },
  { id: 'slack-token', re: /\bxox[abp]-\d{6,}-[0-9A-Za-z-]{20,}/ },
  { id: 'slack-app-token', re: /\bxapp-\d-[A-Z0-9]{8,}-\d{6,}-[a-f0-9]{32,}\b/ },
  { id: 'digitalocean-token', re: /\bdo[por]_v1_[a-f0-9]{64}\b/ },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'nostr-nsec', re: /\bnsec1[02-9ac-hj-np-z]{58}\b/ },
  { id: 'telegram-bot-token', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { id: 'hetzner-token', re: /\bhcloud_[A-Za-z0-9]{64}\b/ },
  // Review wave C SCAN-1: kinds the first version missed.
  {
    id: 'private-key-pem',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{20}\b/ },
  { id: 'stripe-secret-key', re: /\b[sr]k_live_[A-Za-z0-9]{24,}\b/ },
  { id: 'fly-token', re: /\bFlyV1 fm[12]_[A-Za-z0-9+/=_-]{40,}/ },
];

const ALLOW = 'check-no-secrets: allow';
const BINARY = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.icns',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.zip',
  '.gz',
  '.tgz',
  '.br',
  '.pdf',
  '.mp4',
  '.webm',
  '.wasm',
  '.node',
  '.blob',
  '.exe',
]);
// Bigger files and long lines (minified bundles, lockfiles, snapshots) used to be skipped
// entirely, which hid any secret in them (review wave C SCAN-1). Every rule starts with a literal
// prefix, so scanning long lines stays linear.
const MAX_BYTES = 32 * 1024 * 1024;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Mask all but a short prefix, so the report identifies the kind without leaking the value. */
const mask = (s) => `${s.slice(0, Math.min(6, Math.floor(s.length / 4)))}…(${s.length} chars)`;

/** Scan one text; returns findings `{ line, rule, sample }`. */
export const scanText = (text) => {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes(ALLOW)) continue;
    for (const { id, re } of RULES) {
      const m = re.exec(l);
      if (m) out.push({ line: i + 1, rule: id, sample: mask(m[0]) });
    }
  }
  return out;
};

/** UTF-16 text (BOM) is decoded instead of being mistaken for binary because of its NUL bytes. */
const decode = (buf) => {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  return buf.subarray(0, 8000).includes(0) ? undefined : buf.toString('utf8');
};

const scanBuffer = (name, buf, findings) => {
  if (BINARY.has(extname(name).toLowerCase())) return;
  if (buf.length > MAX_BYTES) {
    findings.push({ file: name, line: 0, rule: 'too-large-to-scan', sample: `${buf.length} bytes` });
    return;
  }
  const text = decode(buf);
  if (text === undefined) return;
  for (const f of scanText(text)) findings.push({ file: name, ...f });
};

const main = () => {
  const args = process.argv.slice(2);
  const findings = [];
  let scanned = 0;
  if (args.length && !args[0].startsWith('--')) {
    for (const f of args) {
      if (!existsSync(f) || !statSync(f).isFile()) continue;
      scanBuffer(f, readFileSync(f), findings);
      scanned++;
    }
  } else {
    const stagedOnly = args.includes('--staged');
    const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z')
      .split('\0')
      .filter(Boolean);
    // Staged content is read from the index (what would be committed), not the working tree.
    for (const f of staged) {
      scanBuffer(f, execFileSync('git', ['show', `:${f}`], { maxBuffer: 64 * 1024 * 1024 }), findings);
      scanned++;
    }
    if (!stagedOnly) {
      const stagedSet = new Set(staged);
      for (const f of git('ls-files', '-z').split('\0').filter(Boolean)) {
        if (stagedSet.has(f) || !existsSync(f)) continue;
        if (!statSync(f).isFile()) continue;
        scanBuffer(f, readFileSync(f), findings);
        scanned++;
      }
    }
  }
  if (findings.length) {
    console.error(`check-no-secrets: ${findings.length} token-shaped literal(s) found:`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.rule}  ${f.sample}`);
    console.error(
      'Build fake secrets at runtime (e.g. ["ghp", "x".repeat(36)].join("_")); rotate any real one that leaked.',
    );
    process.exit(1);
  }
  console.log(`check-no-secrets: ${scanned} files clean`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
