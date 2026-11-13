import { z } from 'zod';

/** How to launch a harness in one non-interactive mode. */
export const LaunchSpec = z.object({
  /** Binary to run. Defaults to the first entry of `binaries`. */
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  /** npm package that provides `command` when it is a separate adapter (e.g. claude-agent-acp). */
  npm: z.string().optional(),
  /** Extra environment for this mode (non-secret, e.g. disable auto-update). */
  env: z.record(z.string(), z.string()).default({}),
  note: z.string().optional(),
});
export type LaunchSpec = z.infer<typeof LaunchSpec>;

export const HarnessProtocol = z.enum(['acp', 'claude-sdk', 'codex-app-server', 'pi-rpc', 'opencode']);
export type HarnessProtocol = z.infer<typeof HarnessProtocol>;

const EnvName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

/** One way to log a harness in for sandboxed agents. The credential is a beamhop vault secret. */
export const LoginMethod = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string(),
  /**
   * `broker`: a provider key that beamhop's LLM broker adds to the harness's requests; the agent never
   * sees it. `env`: handed to the harness as an environment variable; the agent CAN read it.
   */
  kind: z.enum(['broker', 'env']),
  /** Vault secret holding the credential. Harnesses listing the same name share it. */
  secret: EnvName,
  /** `env` kind: the variable the harness reads (default: the secret's name). */
  env: EnvName.optional(),
  /**
   * How `beamhop harness check` verifies it: against the provider's (free) key-info endpoint, or by
   * starting the harness in the sandbox with it (`harness`).
   */
  check: z
    .enum(['anthropic', 'anthropic-oauth', 'openai', 'openrouter', 'gemini', 'harness'])
    .default('harness'),
  /** Where to get one, shown in the CLI and the UI. */
  hint: z.string().optional(),
  /** `beamhop harness login --from <tool>` can import it (e.g. `gh auth token`). */
  importFrom: z.enum(['gh']).optional(),
});
export type LoginMethod = z.infer<typeof LoginMethod>;

export const CatalogEntry = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string().min(1),
  homepage: z.url().optional(),
  /** Preferred protocol beamhop uses for this harness. */
  protocol: HarnessProtocol,
  /** Executable names to look for (without extension; PATHEXT is applied on Windows). */
  binaries: z.array(z.string().min(1)).min(1),
  install: z
    .object({
      npm: z.string().optional(),
      brew: z.string().optional(),
      winget: z.string().optional(),
      url: z.url().optional(),
    })
    .default({}),
  /**
   * Extra directories where the installer puts the binary (not always on PATH).
   * Tokens: `~`, `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%`.
   */
  installDirs: z.array(z.string()).default([]),
  /** Config directories (same tokens as installDirs). */
  configDirs: z.array(z.string()).default([]),
  /**
   * Hosts the harness talks to itself, for a service beamhop's LLM broker cannot stand in for (e.g.
   * GitHub Copilot's API). Allowed in the sandbox for sessions on this harness. Leading "*." wildcards.
   */
  network: z.array(z.string()).default([]),
  /**
   * Env var that relocates the harness's config/state directory (e.g. COPILOT_HOME). beamhop points it
   * into the session dir: the sandbox can write there, and the user's own config is never touched.
   */
  /**
   * macOS: the harness is a native binary that verifies TLS through the system (trustd), so its sandbox
   * must allow trustd or every HTTPS request fails. Weakens network isolation a little (see srt).
   */
  macosTrustd: z.boolean().default(false),
  homeEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional(),
  auth: z
    .object({
      /** Any of these env vars set (non-empty) ⇒ an API key is configured. */
      env: z.array(z.string()).default([]),
      /** Any of these files existing ⇒ logged in. */
      files: z.array(z.string()).default([]),
      /** Platforms where credentials may live only in the OS keychain (cannot be verified by file). */
      keychain: z.array(z.enum(['darwin', 'linux', 'win32'])).default([]),
      /** Command the user runs to log in. */
      login: z.string().optional(),
      note: z.string().optional(),
      /**
       * How beamhop logs this harness in for sandboxed agents (`beamhop harness login`, Harnesses screen).
       * Your own login (keychain, ~/.config) is never readable inside the sandbox, so only these count.
       * The first method whose secret is set is used. Empty: beamhop does not manage this harness's login.
       */
      methods: z.array(LoginMethod).default([]),
    })
    .default({ env: [], files: [], keychain: [], methods: [] }),
  versionArgs: z.array(z.string()).default(['--version']),
  /** Supported version range: space-separated comparators, e.g. ">=1.0.0 <2.0.0". */
  versionRange: z.string().optional(),
  modes: z
    .object({
      acp: LaunchSpec.optional(),
      appServer: LaunchSpec.optional(),
      rpc: LaunchSpec.optional(),
      headless: LaunchSpec.optional(),
      sdk: LaunchSpec.optional(),
    })
    .default({}),
  notes: z.string().optional(),
  sources: z.array(z.url()).default([]),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

export const Catalog = z.object({
  /** Schema version of the catalog format. */
  schema: z.literal(1),
  /** Monotonic catalog revision (date-based). Updates with a lower revision are rejected. */
  revision: z.string().regex(/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/),
  harnesses: z.array(CatalogEntry),
});
export type Catalog = z.infer<typeof Catalog>;
