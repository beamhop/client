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

const relOk = (p: string) => !!p && !p.startsWith('/') && !p.split(/[\\/]/).includes('..');
/** A path relative to a harness's home directory (no absolute paths, no `..`). */
const RelPath = z.string().min(1).refine(relOk, 'must stay inside the home directory');
/** Like RelPath; `a|b` means the first of these that exists (paths that differ per platform). */
const RelPathAlt = z
  .string()
  .min(1)
  .refine((p) => p.split('|').every(relOk), 'must stay inside the home directory');

/**
 * `home` kind: the harness's own subscription login (ChatGPT plan, Google account…). beamhop runs the
 * harness's sign-in in a fresh directory, keeps the resulting `files` in the vault (encrypted), and writes
 * them into each session's own copy of that directory. Changes the harness makes (token refresh) are
 * synced back to the vault.
 */
export const HomeLogin = z
  .object({
    /**
     * Environment variable that relocates the harness's config/state directory (CODEX_HOME, XDG_DATA_HOME…).
     * Optional when the harness takes the login as an env var (`asEnv`) or through `{home}` in `extraEnv`.
     */
    env: EnvName.optional(),
    /** The credential files, relative to that directory. All must exist for the login to count. */
    files: z.array(RelPathAlt).min(1),
    /** Give sessions the login as an env var holding one file's contents (e.g. AUGMENT_SESSION_AUTH). */
    asEnv: z.object({ var: EnvName, file: RelPath }).optional(),
    /** Non-secret files written before the sign-in and into every session (e.g. "use the Google login"). */
    seed: z.array(z.object({ path: RelPath, content: z.string() })).default([]),
    /** Extra non-secret environment for the sign-in and sessions; `{home}` is the login directory. */
    extraEnv: z.record(EnvName, z.string()).default({}),
    /** Hosts the subscription talks to (model API, token refresh), allowed in the sandbox with this login. */
    network: z.array(z.string()).default([]),
    /**
     * The harness keeps the login in a database next to other state (OpenCode), so it is moved with its own
     * commands instead of copying files: `exportArgs` prints it (stored in the vault as `file`),
     * `importArgs` loads it into a session's directory (`{file}` is a temporary copy). Both run with the
     * directory's environment.
     */
    transfer: z
      .object({ exportArgs: z.array(z.string()), importArgs: z.array(z.string()), file: RelPath })
      .optional(),
  })
  .refine((h) => h.env || h.asEnv || Object.values(h.extraEnv).some((v) => v.includes('{home}')), {
    message: 'a home login needs `env`, `asEnv` or an `extraEnv` value with {home}',
  });
export type HomeLogin = z.infer<typeof HomeLogin>;

/** How to run a `home` login's sign-in without a terminal. */
export const SignIn = z.object({
  /** Arguments to the harness binary that start the sign-in; `{home}` is the login directory. */
  args: z.array(z.string()),
  /** Device-code variant for a computer without a browser (SSH): shows a code to enter elsewhere. */
  headlessArgs: z.array(z.string()).optional(),
  /** Exits 0 when the login works, without spending tokens (e.g. `login status`). */
  statusArgs: z.array(z.string()).optional(),
  /** Give up after this long (default 300). */
  timeoutSec: z.number().int().positive().max(3600).optional(),
  /**
   * The harness opens the browser itself (`open`/`xdg-open`) without printing the page: beamhop puts
   * stand-ins first on PATH that print it instead, then shows or opens it like any other sign-in page.
   */
  captureOpen: z.boolean().default(false),
  /**
   * Sign in over the harness's JSON-RPC stdio protocol (ACP) instead of a terminal command: these
   * requests are sent in order (newline-delimited JSON-RPC 2.0) and the sign-in is done when the last
   * one answers. `args` starts the protocol server (e.g. `["--acp"]`).
   */
  rpc: z.array(z.object({ method: z.string(), params: z.unknown().optional() })).optional(),
  /**
   * The harness only signs in from its own interactive screen; beamhop runs the harness's own sign-in code
   * with a small helper instead. `pi-oauth`: pi's provider login (pi-ai), written to `home.files[0]`.
   */
  helper: z.object({ kind: z.literal('pi-oauth'), provider: z.string().regex(/^[a-z0-9-]+$/) }).optional(),
});
export type SignIn = z.infer<typeof SignIn>;

/** One way to log a harness in for sandboxed agents. The credential is a beamhop vault secret. */
export const LoginMethod = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    label: z.string(),
    /**
     * `broker`: a provider key that beamhop's LLM broker adds to the harness's requests; the agent never
     * sees it. `env`: handed to the harness as an environment variable; the agent CAN read it. `home`: the
     * harness's own subscription login, as files in its home directory (see HomeLogin); the agent CAN read it.
     */
    kind: z.enum(['broker', 'env', 'home']),
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
    /** `home` kind: where the login lives. */
    home: HomeLogin.optional(),
    /** `home` kind: how to sign in. */
    signIn: SignIn.optional(),
  })
  .refine((m) => m.kind !== 'home' || (m.home && m.signIn), {
    message: 'a home login needs `home` and `signIn`',
  });
export type LoginMethod = z.infer<typeof LoginMethod>;

/**
 * A harness's own standalone installer for one platform. `archive` pins an exact file per CPU arch
 * (`{arch}` in the URL is replaced with node's `process.arch`) and is checked against its sha256 before
 * it is unpacked into `<beamhop home>/harnesses/<id>/`; `bin` is the binary's path inside the archive.
 * `script` is the vendor's own installer script (https only), run with bash as the user, never sudo.
 */
export const NativeInstaller = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('archive'),
    url: z.url().regex(/^https:\/\//),
    sha256: z.record(z.string().regex(/^[a-z0-9_]+$/), z.string().regex(/^[a-f0-9]{64}$/)),
    bin: z
      .string()
      .min(1)
      .refine(
        (b) => !b.startsWith('/') && !b.split(/[\\/]/).includes('..'),
        'bin must stay inside the archive',
      ),
  }),
  z.object({ kind: z.literal('script'), url: z.url().regex(/^https:\/\//) }),
]);
export type NativeInstaller = z.infer<typeof NativeInstaller>;

/**
 * The harness's own login, run by the daemon in a pseudo-terminal without a visible terminal
 * (`harness.loginFlow`). Only for logins that need no typing: they print a URL (and maybe a device code)
 * and finish once the user signs in in the browser.
 */
export const LoginFlow = z.object({
  /** Arguments to the harness's binary (e.g. `["login"]`). */
  args: z.array(z.string()),
  kind: z.enum(['browser', 'device-code']),
  /** Give up after this long (default 300). */
  timeoutSec: z.number().int().positive().max(3600).optional(),
  /**
   * Take the first match of `pattern` from the output and store it as the vault login `method` (the
   * same as `beamhop harness login`), e.g. the token `claude setup-token` prints. Redacted from output.
   */
  capture: z
    .object({
      method: z.string().regex(/^[a-z0-9-]+$/),
      pattern: z
        .string()
        .min(1)
        .refine((p) => {
          try {
            new RegExp(p);
            return true;
          } catch {
            return false;
          }
        }, 'pattern must be a valid regular expression'),
    })
    .optional(),
});
export type LoginFlow = z.infer<typeof LoginFlow>;

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
      /** The harness's own installer per platform (tried before brew / npm). */
      native: z
        .object({
          darwin: NativeInstaller.optional(),
          linux: NativeInstaller.optional(),
          win32: NativeInstaller.optional(),
        })
        .optional(),
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
      /** The harness's own login without a terminal (`harness.loginFlow`). */
      loginFlow: LoginFlow.optional(),
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
