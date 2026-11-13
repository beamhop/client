/**
 * Harness logins for sandboxed agents (`beamhop harness login`, the Harnesses screen).
 *
 * A harness's own login (macOS keychain, ~/.config/…) is never readable inside the sandbox, so beamhop
 * keeps one credential per harness in its vault, as declared by the catalog (`auth.methods`):
 *
 *   broker  a provider key (ANTHROPIC_API_KEY, a Claude subscription token, …) that the LLM broker adds
 *           to the harness's requests. The agent never sees it.
 *   env     a token handed to the harness as an env var (GitHub Copilot's COPILOT_GITHUB_TOKEN). The
 *           agent CAN read it.
 *
 * Every agent on the harness uses its login; an agent can override it with `secretEnv: ["ENV=SECRET"]`.
 * `checkLogin` verifies the active credential for real: against the provider's (free) key endpoint, or
 * by starting the harness in the sandbox (env kind) and closing it before any prompt.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentConfig,
  BeamhopError,
  DEFAULT_MODEL,
  type HarnessSession,
  type HarnessView,
  isReservedSecretName,
  type ModelOption,
  paths,
  type SecretStore,
} from '@beamhop/core';
import { type CatalogEntry, findHarness, type LoginMethod, loadCatalog } from '@beamhop/harness-catalog';
import { compilePolicy, LLM_PROVIDER_HOSTS } from '@beamhop/sandbox';
import type { Daemon } from './daemon.ts';
import { decodeBlob, HomeLoginSync, homeArgs, homeEnv, homeOf, writeHome } from './home-login.ts';

export type HarnessLogin = NonNullable<HarnessView['login']>;
type CheckResult =
  | { status: 'logged-in' | 'invalid'; message: string }
  | { status: 'error'; message: string };
interface StoredCheck {
  method: string;
  /** The secret's updatedAt when checked: a new value makes the old result stale. */
  secretUpdatedAt?: string;
  status: 'logged-in' | 'invalid';
  message: string;
  checkedAt: string;
}

const KV_NS = 'harness-login';
let catalog: ReturnType<typeof loadCatalog> | undefined;

/** Login methods for a harness id (empty: not managed by beamhop). */
export const loginMethods = (harnessId: string): LoginMethod[] => {
  catalog ??= loadCatalog();
  const entry: CatalogEntry | undefined = findHarness(catalog, harnessId);
  return entry?.auth.methods ?? [];
};

const secretIndex = async (secrets: SecretStore) =>
  new Map((await secrets.list().catch(() => [])).map((s) => [s.name, s.updatedAt]));

/** The method in use: the first one whose secret is set. */
export const activeMethod = async (secrets: SecretStore, harnessId: string) => {
  const idx = await secretIndex(secrets);
  return loginMethods(harnessId).find((m) => idx.has(m.secret));
};

/** Login status for the harness view (no network: the last real check, if still current). */
export const harnessLogin = async (d: Daemon, harnessId: string): Promise<HarnessLogin> => {
  const methods = loginMethods(harnessId);
  const idx = await secretIndex(d.secrets);
  const views = methods.map((m) => ({
    id: m.id,
    label: m.label,
    kind: m.kind,
    secret: m.secret,
    set: idx.has(m.secret),
    ...(m.hint ? { hint: m.hint } : {}),
    ...(m.importFrom ? { importFrom: m.importFrom } : {}),
  }));
  if (!methods.length) return { status: 'unmanaged', methods: views };
  const active = methods.find((m) => idx.has(m.secret));
  if (!active)
    return {
      status: 'logged-out',
      methods: views,
      message: `Not logged in. Run: beamhop harness login ${harnessId}`,
    };
  const last = d.store.kv.get<StoredCheck>(KV_NS, harnessId);
  const current = last && last.method === active.id && last.secretUpdatedAt === idx.get(active.secret);
  return {
    status: current ? last.status : 'unchecked',
    method: active.id,
    methods: views,
    ...(current ? { checkedAt: last.checkedAt, message: last.message } : {}),
  };
};

/**
 * Why a session on this harness cannot authenticate, or undefined when it can (or beamhop does not
 * manage its login). A harness started without credentials does not fail: it waits on its own login
 * flow, which nobody can answer inside the sandbox, so the turn would hang until stopped.
 */
export const loginProblem = async (
  d: Daemon,
  agent: Pick<AgentConfig, 'secretEnv'>,
  harnessId: string,
  harnessName: string,
): Promise<string | undefined> => {
  const login = await harnessLogin(d, harnessId);
  // Only a missing sign-in blocks: an "invalid" verdict may come from a check that failed for another
  // reason (network), and the harness's own error explains a really rejected login better.
  if (login.status !== 'logged-out') return undefined;
  // The agent brings its own credential for one of the harness's login variables (secretEnv override).
  const vars = new Set(loginMethods(harnessId).flatMap((m) => [m.env ?? m.secret, m.secret]));
  if ((agent.secretEnv ?? []).some((e) => vars.has(e.split('=')[0]!))) return undefined;
  return `${harnessName} is not signed in. Sign in with: beamhop harness login ${harnessId}`;
};

/**
 * Env-kind credentials for a session: the harness login, unless the agent maps the same variable to a
 * secret of its own (`secretEnv: ["COPILOT_GITHUB_TOKEN=TEAM_TOKEN"]`). Broker-kind logins are not
 * returned: the broker reads them from the vault itself.
 */
export const sessionCredentials = async (
  secrets: SecretStore,
  agent: Pick<AgentConfig, 'name' | 'secretEnv'>,
  harnessId: string,
  harnessName: string,
): Promise<Record<string, string>> => {
  const env: Record<string, string> = {};
  for (const entry of agent.secretEnv ?? []) {
    const [name, secretName = name] = entry.split('=') as [string, string?];
    // Also checked by the config schema; repeated here for configs written by hand.
    if (isReservedSecretName(secretName))
      throw new BeamhopError(
        'forbidden',
        `agent ${agent.name} asks for ${secretName}, which beamhop keeps for itself; remove it from secretEnv`,
      );
    const value = await secrets.get(secretName);
    if (!value)
      throw new BeamhopError(
        'unavailable',
        `secret ${secretName} is not set (agent ${agent.name} passes it to ${harnessName}). Set it with: beamhop secret set ${secretName}`,
      );
    env[name] = value;
  }
  const active = await activeMethod(secrets, harnessId);
  if (active?.kind === 'env') {
    const name = active.env ?? active.secret;
    if (!(name in env)) {
      const value = await secrets.get(active.secret);
      if (value) env[name] = value;
    }
  }
  return env;
};

/** Store a credential for `method` (default: the harness's first method). Returns the method used. */
export const resolveMethod = (harnessId: string, methodId?: string): LoginMethod => {
  const methods = loginMethods(harnessId);
  if (!methods.length)
    throw new BeamhopError(
      'unavailable',
      `beamhop does not manage ${harnessId}'s login; configure it in the harness itself (it cannot use it inside the sandbox)`,
    );
  const m = methodId ? methods.find((x) => x.id === methodId) : methods[0];
  if (!m)
    throw new BeamhopError(
      'invalid_input',
      `unknown login method ${methodId} for ${harnessId}; one of: ${methods.map((x) => x.id).join(', ')}`,
    );
  return m;
};

// ───────────────────────────── real checks ─────────────────────────────

type Fetch = typeof fetch;

const httpCheck = async (
  f: Fetch,
  url: string,
  headers: Record<string, string>,
  what: string,
): Promise<CheckResult> => {
  let res: Response;
  try {
    res = await f(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    return { status: 'error', message: `could not reach ${new URL(url).host}: ${(e as Error).message}` };
  }
  await res.body?.cancel().catch(() => {});
  if (res.ok) return { status: 'logged-in', message: `${what} accepted` };
  if (res.status === 401 || res.status === 403)
    return { status: 'invalid', message: `${what} rejected (HTTP ${res.status})` };
  return { status: 'error', message: `${new URL(url).host} answered HTTP ${res.status}` };
};

/** Verify a key against its provider (no tokens spent). */
export const checkProviderKey = (
  check: LoginMethod['check'],
  key: string,
  f: Fetch = fetch,
): Promise<CheckResult> | undefined => {
  switch (check) {
    case 'anthropic':
      return httpCheck(
        f,
        'https://api.anthropic.com/v1/models?limit=1',
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        'Anthropic API key',
      );
    case 'anthropic-oauth':
      return httpCheck(
        f,
        'https://api.anthropic.com/v1/models?limit=1',
        {
          authorization: `Bearer ${key}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        'Claude subscription token',
      );
    case 'openai':
      return httpCheck(
        f,
        'https://api.openai.com/v1/models',
        { authorization: `Bearer ${key}` },
        'OpenAI API key',
      );
    case 'openrouter':
      return httpCheck(
        f,
        'https://openrouter.ai/api/v1/key',
        { authorization: `Bearer ${key}` },
        'OpenRouter key',
      );
    case 'gemini':
      return httpCheck(
        f,
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
        { 'x-goog-api-key': key },
        'Gemini API key',
      );
    default:
      return undefined;
  }
};

/** The stored sign-in could not be set up for a throwaway session (damaged or unreadable). */
class LoginSetupError extends Error {}

/**
 * Start the harness in a throwaway sandboxed session with its login (the same sandbox, hosts, trustd and
 * sign-in files a real session gets), run `use` on it, then close it. No prompt is sent.
 */
export const withThrowawaySession = async <T>(
  d: Daemon,
  harnessId: string,
  purpose: string,
  use: (session: HarnessSession) => Promise<T>,
): Promise<T> => {
  const plugin = d.registry.harness(harnessId);
  if (!plugin) throw new BeamhopError('not_found', `${harnessId} is not installed`);
  const home = paths(d.home);
  const dir = join(home.sessions, `${purpose}-${harnessId}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let homeSync: HomeLoginSync | undefined;
  let sandbox: Awaited<ReturnType<Daemon['sandboxFactory']>> | undefined;
  try {
    const policy = compilePolicy(
      'workspace',
      [],
      { fs: { read: [dir], write: [dir], deny: [d.home] } },
      { own: { dirs: [dir], beamhopHome: d.home } },
    );
    if (d.llmProxy) {
      const llm = new Set<string>(LLM_PROVIDER_HOSTS);
      policy.net.allow = policy.net.allow.filter((h) => !llm.has(h));
    }
    for (const h of plugin.network ?? []) if (!policy.net.allow.includes(h)) policy.net.allow.push(h);
    const env: Record<string, string> = {
      ...(await sessionCredentials(
        d.secrets,
        { name: `(${purpose})`, secretEnv: [] },
        harnessId,
        plugin.displayName,
      )),
    };
    if (plugin.homeEnv) {
      mkdirSync(join(dir, 'harness-home'), { recursive: true, mode: 0o700 });
      env[plugin.homeEnv] = join(dir, 'harness-home');
    }
    // A subscription login: its files in the throwaway home (a refresh meanwhile is saved back).
    const active = await activeMethod(d.secrets, harnessId);
    if (active?.kind === 'home') {
      const hl = homeOf(active);
      const blob = decodeBlob(await d.secrets.get(active.secret));
      if (!blob) throw new LoginSetupError('the stored sign-in is damaged; sign in again');
      const hdir = join(dir, hl.env && hl.env === plugin.homeEnv ? 'harness-home' : 'login-home');
      try {
        homeSync = await HomeLoginSync.open(d.secrets, active, hdir, blob, {
          ...(hl.transfer ? { bin: (await plugin.detect().catch(() => null))?.path } : {}),
        });
      } catch (e) {
        throw new LoginSetupError((e as Error).message);
      }
      Object.assign(env, homeEnv(hdir, hl, blob));
      for (const h of hl.network) if (!policy.net.allow.includes(h)) policy.net.allow.push(h);
    }
    sandbox = await d.sandboxFactory(policy, {
      env,
      localAllow: [],
      log: d.log.child({ [purpose]: harnessId }),
      ...(plugin.macosTrustd ? { macosTrustd: true } : {}),
    });
    const session = await plugin.start(
      {
        sessionId: `${purpose}-${harnessId}`,
        agent: `(${purpose})`,
        model: DEFAULT_MODEL,
        cwd: dir,
        mounts: [],
        permissionMode: 'read-only',
        env: { ...env },
        mcpServers: [],
      },
      sandbox,
    );
    try {
      return await use(session);
    } finally {
      await session.close().catch(() => {});
    }
  } finally {
    await sandbox?.close().catch(() => {});
    await homeSync?.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Start the harness in a throwaway sandboxed session with its login, then close it (no prompt sent). */
const checkByStarting = async (d: Daemon, harnessId: string): Promise<CheckResult> => {
  const plugin = d.registry.harness(harnessId);
  if (!plugin) return { status: 'error', message: `${harnessId} is not installed` };
  try {
    await withThrowawaySession(d, harnessId, 'logincheck', async () => undefined);
    return { status: 'logged-in', message: `${plugin.displayName} started and authenticated` };
  } catch (e) {
    const msg = (e as Error).message;
    if (e instanceof LoginSetupError) return { status: 'invalid', message: msg };
    return /auth|login|unauthori[sz]ed|forbidden|token/i.test(msg)
      ? { status: 'invalid', message: msg }
      : { status: 'error', message: msg };
  }
};

const MODELS_TTL_MS = 10 * 60_000;
const modelCache = new Map<string, { at: number; models: ModelOption[] }>();

/**
 * The models a harness offers with its current sign-in, asked of the harness itself in a throwaway
 * session (a few seconds), cached for 10 minutes per harness and sign-in.
 */
export const harnessModels = async (
  d: Daemon,
  harnessId: string,
  refresh = false,
): Promise<{ models: ModelOption[]; error?: string }> => {
  const key = `${harnessId}|${(await activeMethod(d.secrets, harnessId))?.id ?? '-'}`;
  const hit = modelCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < MODELS_TTL_MS) return { models: hit.models };
  try {
    const models = await withThrowawaySession(d, harnessId, 'models', async (s) =>
      s.models ? await s.models() : undefined,
    );
    if (!models) return { models: [], error: 'this harness cannot list its models; type a model id' };
    modelCache.set(key, { at: Date.now(), models });
    return { models };
  } catch (e) {
    return { models: [], error: (e as Error).message };
  }
};

/**
 * A subscription login's own status command (e.g. `codex login status`), run with the stored files in a
 * throwaway home. No tokens spent. Undefined when the method has none.
 */
const checkByStatus = async (
  d: Daemon,
  harnessId: string,
  m: LoginMethod,
): Promise<CheckResult | undefined> => {
  const args = m.signIn?.statusArgs;
  const plugin = d.registry.harness(harnessId);
  if (!args || !plugin) return undefined;
  const bin = (await plugin.detect().catch(() => null))?.path;
  if (!bin) return { status: 'error', message: `${plugin.displayName} is not installed` };
  const home = homeOf(m);
  const blob = decodeBlob(await d.secrets.get(m.secret));
  if (!blob) return { status: 'invalid', message: 'the stored sign-in is damaged; sign in again' };
  const dir = join(paths(d.home).sessions, `loginstatus-${harnessId}-${randomBytes(4).toString('hex')}`);
  try {
    writeHome(dir, home, blob);
    const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
      execFile(
        bin,
        homeArgs(args, dir),
        { env: { ...process.env, ...homeEnv(dir, home, blob) }, timeout: 30_000 },
        (err, stdout, stderr) =>
          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            out: `${stdout}${stderr}`.trim().split('\n').slice(-1)[0] ?? '',
          }),
      );
    });
    return r.code === 0
      ? { status: 'logged-in', message: `${m.label} sign-in works` }
      : { status: 'invalid', message: r.out || `${m.label} sign-in rejected` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Verify the harness's active login for real and remember the result. */
export const checkLogin = async (d: Daemon, harnessId: string, f: Fetch = fetch): Promise<HarnessLogin> => {
  const active = await activeMethod(d.secrets, harnessId);
  if (active) {
    const key = (await d.secrets.get(active.secret)) ?? '';
    const r =
      (active.kind === 'home' ? undefined : await checkProviderKey(active.check, key, f)) ??
      (active.kind === 'home' ? await checkByStatus(d, harnessId, active) : undefined) ??
      (await checkByStarting(d, harnessId));
    if (r.status !== 'error') {
      const idx = await secretIndex(d.secrets);
      const stored: StoredCheck = {
        method: active.id,
        status: r.status,
        message: r.message,
        checkedAt: new Date(d.now()).toISOString(),
      };
      const updatedAt = idx.get(active.secret);
      if (updatedAt) stored.secretUpdatedAt = updatedAt;
      d.store.kv.set(KV_NS, harnessId, stored);
    } else {
      const view = await harnessLogin(d, harnessId);
      return { ...view, status: 'unchecked', message: `Check failed: ${r.message}` };
    }
  }
  return harnessLogin(d, harnessId);
};
