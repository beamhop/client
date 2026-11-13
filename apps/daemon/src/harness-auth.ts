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
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentConfig, BeamhopError, type HarnessView, paths, type SecretStore } from '@beamhop/core';
import { type CatalogEntry, findHarness, type LoginMethod, loadCatalog } from '@beamhop/harness-catalog';
import { compilePolicy, LLM_PROVIDER_HOSTS } from '@beamhop/sandbox';
import type { Daemon } from './daemon.ts';

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

/** Start the harness in a throwaway sandboxed session with its login, then close it (no prompt sent). */
const checkByStarting = async (d: Daemon, harnessId: string): Promise<CheckResult> => {
  const plugin = d.registry.harness(harnessId);
  if (!plugin) return { status: 'error', message: `${harnessId} is not installed` };
  const home = paths(d.home);
  const dir = join(home.sessions, `logincheck-${harnessId}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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
      { name: '(login check)', secretEnv: [] },
      harnessId,
      plugin.displayName,
    )),
  };
  if (plugin.homeEnv) {
    mkdirSync(join(dir, 'harness-home'), { recursive: true, mode: 0o700 });
    env[plugin.homeEnv] = join(dir, 'harness-home');
  }
  let sandbox: Awaited<ReturnType<Daemon['sandboxFactory']>> | undefined;
  try {
    sandbox = await d.sandboxFactory(policy, {
      env,
      localAllow: [],
      log: d.log.child({ check: harnessId }),
      ...(plugin.macosTrustd ? { macosTrustd: true } : {}),
    });
    const session = await plugin.start(
      {
        sessionId: `logincheck-${harnessId}`,
        agent: '(login check)',
        model: 'default',
        cwd: dir,
        mounts: [],
        permissionMode: 'read-only',
        env: { ...env },
        mcpServers: [],
      },
      sandbox,
    );
    await session.close();
    return { status: 'logged-in', message: `${plugin.displayName} started and authenticated` };
  } catch (e) {
    const msg = (e as Error).message;
    return /auth|login|unauthori[sz]ed|forbidden|token/i.test(msg)
      ? { status: 'invalid', message: msg }
      : { status: 'error', message: msg };
  } finally {
    await sandbox?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Verify the harness's active login for real and remember the result. */
export const checkLogin = async (d: Daemon, harnessId: string, f: Fetch = fetch): Promise<HarnessLogin> => {
  const active = await activeMethod(d.secrets, harnessId);
  if (active) {
    const key = (await d.secrets.get(active.secret)) ?? '';
    const r = (await checkProviderKey(active.check, key, f)) ?? (await checkByStarting(d, harnessId));
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
