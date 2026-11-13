/** Outbound DLP (§7A): gitleaks-style patterns + exact known secret values. */

export interface DlpFinding {
  type: string;
  index: number;
  length: number;
}

export interface DlpScan {
  findings: DlpFinding[];
  redacted: string;
}

interface Rule {
  type: string;
  re: RegExp;
  /** Capture group holding the secret (default: whole match). */
  group?: number;
  validate?: (value: string) => boolean;
}

/** Shannon entropy in bits per char. */
export const entropy = (s: string): number => {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
};

const looksRandom = (v: string): boolean => {
  if (v.length < 16) return false;
  if (/^[a-z]+$/i.test(v) && !/[0-9]/.test(v) && entropy(v) < 4) return false; // plain words
  if (/^(.)\1+$/.test(v)) return false;
  if (/^(x+|\*+|\.+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\})$/i.test(v)) return false;
  if (/^(true|false|null|undefined|changeme|password|placeholder|example|redacted)/i.test(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(v)).length;
  return classes >= 2 && entropy(v) >= 3.5;
};

// Order matters only for readability; overlapping findings are merged (longest wins).
const RULES: Rule[] = [
  {
    type: 'private-key',
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { type: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g },
  {
    type: 'aws-secret-access-key',
    re: /\baws_?secret_?access_?key\b["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    group: 1,
  },
  { type: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g },
  { type: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{50,255}\b/g },
  { type: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'slack-token', re: /\bxox[abposrce]-(?:[A-Za-z0-9]+-){1,4}[A-Za-z0-9]{6,}\b/g },
  {
    type: 'slack-webhook',
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/g,
  },
  { type: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9]{2,10}-[A-Za-z0-9_-]{32,}/g },
  { type: 'openrouter-api-key', re: /\bsk-or-v1-[a-f0-9]{48,}\b/g },
  {
    type: 'openai-api-key',
    re: /\bsk-(?!ant-|or-v1-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    validate: (v) => /[0-9]/.test(v) && /[A-Za-z]/.test(v.slice(3)),
  },
  { type: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/g },
  { type: 'telegram-bot-token', re: /\b\d{6,12}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  { type: 'nostr-nsec', re: /\bnsec1[02-9ac-hj-np-z]{58}\b/g },
  {
    type: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  { type: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    type: 'url-credentials',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{6,})@[^\s/]+/gi,
    group: 1,
    validate: (v) => !/^(password|pass|x+|\*+|\$\{.*\})$/i.test(v),
  },
  {
    type: 'generic-secret',
    re: /\b[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key|credential)s?[A-Za-z0-9_.-]*["']?\s*(?::|=|:=|=>)\s*["']?([A-Za-z0-9_\-+/=.~]{16,})["']?/gi,
    group: 1,
    validate: looksRandom,
  },
];

const MIN_KNOWN_SECRET_LENGTH = 6;

/** Pattern rules + exact known values over `text` (no normalization, no decoding). */
const scanPlain = (text: string, known: readonly string[]): DlpFinding[] => {
  const raw: DlpFinding[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const value = rule.group ? m[rule.group] : m[0];
      if (!value || m.index === undefined) continue;
      if (rule.validate && !rule.validate(value)) continue;
      const offset = rule.group ? m[0].indexOf(value) : 0;
      raw.push({ type: rule.type, index: m.index + offset, length: value.length });
    }
  }
  for (const secret of known) {
    let i = text.indexOf(secret);
    while (i !== -1) {
      raw.push({ type: 'known-secret', index: i, length: secret.length });
      i = text.indexOf(secret, i + secret.length);
    }
  }
  return raw;
};

/**
 * Invisible / formatting code points that render as nothing and are used to break up a secret
 * (zero-width space/joiners, word joiner, BOM, soft hyphen, bidi controls, variation selectors,
 * Hangul fillers, Mongolian vowel separator).
 */
const INVISIBLE_RANGES: [number, number][] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xe0000, 0xe007f], // tag characters
];
const isInvisible = (ch: string): boolean => {
  const cp = ch.codePointAt(0) ?? 0;
  return INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
};

/**
 * Strip invisible chars and NFKC-fold each code point (fullwidth / compatibility forms → ASCII).
 * `starts[i]`/`ends[i]` map normalized UTF-16 index i back to its span in the original text.
 */
const normalizeForScan = (text: string) => {
  let out = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of text) {
    if (!isInvisible(ch)) {
      const n = ch.normalize('NFKC');
      for (let k = 0; k < n.length; k++) {
        starts.push(i);
        ends.push(i + ch.length);
      }
      out += n;
    }
    i += ch.length;
  }
  return { out, starts, ends };
};

/**
 * Substrings that appear in every base64 / base64url / hex encoding of `secret`, whatever the
 * byte alignment inside a larger encoded blob (3 base64 alignments: only the chars whose 6 bits
 * all come from the secret are kept).
 */
const encodedForms = (secret: string): string[] => {
  const b = Buffer.from(secret, 'utf8');
  const forms = new Set<string>([b.toString('hex'), b.toString('hex').toUpperCase()]);
  for (let k = 0; k < 3; k++) {
    const enc = Buffer.concat([Buffer.alloc(k), b]).toString('base64');
    const core = enc.slice(Math.ceil((8 * k) / 6), Math.floor((8 * (k + b.length)) / 6));
    if (core.length < 8) continue;
    forms.add(core);
    forms.add(core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return [...forms];
};

const ENCODED_RUN_CHAR = /[A-Za-z0-9+/_=-]/;
/** Extend [index, index+length) to the whole surrounding encoded token. */
const widenToRun = (text: string, index: number, length: number): [number, number] => {
  let a = index;
  let b = index + length;
  while (a > 0 && ENCODED_RUN_CHAR.test(text[a - 1] ?? '')) a--;
  while (b < text.length && ENCODED_RUN_CHAR.test(text[b] ?? '')) b++;
  return [a, b];
};

const MAX_DECODE_RUNS = 200;
const printableRatio = (s: string): number => {
  if (!s) return 0;
  let ok = 0;
  for (const ch of s) if (/[\x20-\x7e\t\r\n]/.test(ch)) ok++;
  return ok / [...s].length;
};

/** Decode base64 / hex tokens and scan the decoded text; a hit flags the whole encoded token. */
const scanDecoded = (text: string, known: readonly string[]): DlpFinding[] => {
  const out: DlpFinding[] = [];
  let runs = 0;
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
    if (m.index === undefined || ++runs > MAX_DECODE_RUNS) break;
    const tok = m[0];
    const decoded: string[] = [];
    if (/^[0-9a-fA-F]+$/.test(tok) && tok.length % 2 === 0)
      decoded.push(Buffer.from(tok, 'hex').toString('utf8'));
    decoded.push(Buffer.from(tok, 'base64').toString('utf8'));
    for (const d of decoded) {
      if (printableRatio(d) < 0.9) continue;
      const hits = scanPlain(d, known);
      if (hits.length) {
        const type = hits.some((h) => h.type === 'known-secret')
          ? 'known-secret'
          : `encoded-${hits[0]?.type}`;
        out.push({ type, index: m.index, length: tok.length });
        break;
      }
    }
  }
  return out;
};

/**
 * Scan text for secrets. `knownSecrets` are exact values held by the broker.
 *
 * Resists cheap obfuscation: invisible chars are stripped and compatibility forms folded (NFKC)
 * before matching, known secrets are also matched in base64 / base64url / hex form (any
 * alignment), and base64 / hex tokens are decoded and re-scanned. Not caught (see
 * docs/security/REVIEW-wave-a.md): secrets split across messages, cross-script homoglyphs,
 * custom encodings (rot13, reversed, gzip, …).
 */
export const scanOutbound = (text: string, knownSecrets: readonly string[] = []): DlpScan => {
  const known = [...new Set(knownSecrets)].filter((s) => s.length >= MIN_KNOWN_SECRET_LENGTH);
  const norm = normalizeForScan(text);
  const t = norm.out;
  const inNorm: DlpFinding[] = [...scanPlain(t, known), ...scanDecoded(t, known)];
  for (const secret of known) {
    for (const form of encodedForms(secret)) {
      let i = t.indexOf(form);
      while (i !== -1) {
        const [a, b] = widenToRun(t, i, form.length);
        inNorm.push({ type: 'known-secret', index: a, length: b - a });
        i = t.indexOf(form, i + form.length);
      }
    }
  }
  // Map back to original coordinates.
  const raw: DlpFinding[] = inNorm
    .filter((f) => f.length > 0)
    .map((f) => {
      const a = norm.starts[f.index] ?? 0;
      const b = norm.ends[f.index + f.length - 1] ?? text.length;
      return { type: f.type, index: a, length: b - a };
    });

  // Merge overlaps: sort by start, prefer known-secret, then longer.
  raw.sort((a, b) => a.index - b.index || b.length - a.length);
  const findings: DlpFinding[] = [];
  for (const f of raw) {
    const last = findings[findings.length - 1];
    if (last && f.index < last.index + last.length) {
      const end = Math.max(last.index + last.length, f.index + f.length);
      if (f.type === 'known-secret' && last.type !== 'known-secret') last.type = 'known-secret';
      last.length = end - last.index;
      continue;
    }
    findings.push({ ...f });
  }

  let redacted = '';
  let pos = 0;
  for (const f of findings) {
    redacted += text.slice(pos, f.index) + `[REDACTED:${f.type}]`;
    pos = f.index + f.length;
  }
  redacted += text.slice(pos);
  return { findings, redacted };
};

export type DlpMode = 'block' | 'redact' | 'warn';

export interface DlpResult {
  /** False when the message must not be sent (mode `block` with findings). */
  ok: boolean;
  /** Text to send: original (warn / clean), redacted (redact). For a block it is the redacted text, for logs. */
  text: string;
  findings: DlpFinding[];
  action: 'pass' | 'warned' | 'redacted' | 'blocked';
}

/** Apply a role's DLP mode to outbound text (messages to owners use `warn`). */
export const applyDlp = (mode: DlpMode, text: string, knownSecrets: readonly string[] = []): DlpResult => {
  const scan = scanOutbound(text, knownSecrets);
  if (scan.findings.length === 0) return { ok: true, text, findings: [], action: 'pass' };
  switch (mode) {
    case 'block':
      return { ok: false, text: scan.redacted, findings: scan.findings, action: 'blocked' };
    case 'redact':
      return { ok: true, text: scan.redacted, findings: scan.findings, action: 'redacted' };
    case 'warn':
      return { ok: true, text, findings: scan.findings, action: 'warned' };
  }
};
