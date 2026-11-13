import { BeamhopError, Slug } from '@beamhop/core';

/**
 * Input validation for everything that ends up inside cloud-init, container env or provider
 * resource names. These values are rendered into YAML and argv lists that run as root on a
 * fresh server, so we accept only narrow, well-known shapes.
 */

const NPUB = /^npub1[02-9ac-hj-np-z]{58}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** npm package spec: optional scope, name, optional exact-ish version/range without spaces or shell chars. */
const NPM_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[0-9A-Za-z.^~<>=*+-]+)?$/;
/** A reference to a secret name (never a secret value). */
const SECRET_REF = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SSH_PUBKEY =
  /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+(?: [^\n\r]{0,200})?$/;

const bad = (msg: string): never => {
  throw new BeamhopError('invalid_input', msg);
};

export const assertAgentSlug = (agent: string): string => {
  const r = Slug.safeParse(agent);
  if (!r.success) bad(`invalid agent name "${agent}": use lowercase letters, digits and dashes`);
  // Provider names (Fly app names, DO droplet names) are limited; "beamhop-" + 48 chars fits all five.
  return agent;
};

export const assertNpub = (npub: string): string =>
  NPUB.test(npub) ? npub : bad('ownerNpub must be an npub1… bech32 string');

/** The one-time provisioning key is a *public* key: 64-char lowercase hex or an npub. */
export const assertPubkey = (pk: string): string =>
  HEX64.test(pk) || NPUB.test(pk) ? pk : bad('provisioningPubkey must be a 64-char hex pubkey or an npub');

/** One-time provisioning binding token: 32+ random bytes, base64url (review wave C PROV-1). */
export const assertProvisioningToken = (t: string): string =>
  /^[A-Za-z0-9_-]{43,128}$/.test(t) ? t : bad('provisioningToken must be 43-128 base64url characters');

export const assertVersion = (v: string): string =>
  SEMVER.test(v) ? v : bad(`beamhopVersion must be an exact semver version, got "${v}"`);

export const assertNpmSpec = (spec: string): string =>
  NPM_SPEC.test(spec) ? spec : bad(`invalid npm package spec "${spec}"`);

/** A daemon nsec *reference* (vault entry name). Refuses anything that looks like a key. */
export const assertSecretRef = (ref: string): string => {
  if (looksLikeSecret(ref)) bad('daemonNsecRef must be a reference name, not a secret value');
  return SECRET_REF.test(ref) ? ref : bad(`invalid secret reference "${ref}"`);
};

export const assertSshPubkey = (key: string): string =>
  SSH_PUBKEY.test(key.trim()) ? key.trim() : bad('sshAuthorizedKeys entries must be OpenSSH public keys');

/**
 * Heuristic secret detector used as a last line of defence before anything is sent to a provider
 * (user_data, env vars). Mirrors a small subset of gitleaks-style patterns.
 */
export const SECRET_PATTERNS: RegExp[] = [
  /nsec1[02-9ac-hj-np-z]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic style
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bdop_v1_[a-f0-9]{20,}/, // DigitalOcean
  /\brnd_[A-Za-z0-9]{16,}/, // Render
  /\bFlyV1 [A-Za-z0-9+/=_,-]{20,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
];

export const looksLikeSecret = (s: string): boolean => SECRET_PATTERNS.some((p) => p.test(s));

/** Throw if `text` contains a known secret pattern or any of the `known` secret values. */
export const assertNoSecrets = (text: string, what: string, known: (string | undefined)[] = []): void => {
  for (const k of known) {
    if (k && k.length >= 8 && text.includes(k)) bad(`refusing to send ${what}: it contains a secret value`);
  }
  if (looksLikeSecret(text)) bad(`refusing to send ${what}: it contains a secret-looking string`);
};
