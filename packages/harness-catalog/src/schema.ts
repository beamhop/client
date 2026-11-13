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
    })
    .default({ env: [], files: [], keychain: [] }),
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
