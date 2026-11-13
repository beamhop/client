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

/** Scan text for secrets. `knownSecrets` are exact values held by the broker. */
export const scanOutbound = (text: string, knownSecrets: readonly string[] = []): DlpScan => {
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
  const known = [...new Set(knownSecrets)].filter((s) => s.length >= MIN_KNOWN_SECRET_LENGTH);
  for (const secret of known) {
    let i = text.indexOf(secret);
    while (i !== -1) {
      raw.push({ type: 'known-secret', index: i, length: secret.length });
      i = text.indexOf(secret, i + secret.length);
    }
  }

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
