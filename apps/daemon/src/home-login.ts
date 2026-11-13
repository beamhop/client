/**
 * Subscription logins (`home` login methods): the harness's own sign-in (ChatGPT plan, Google account…)
 * kept for sandboxed agents.
 *
 * The sign-in runs with the harness's home directory (`CODEX_HOME`, `XDG_DATA_HOME`…) pointed at a fresh
 * directory; the credential files it writes are stored in the vault as one secret (encrypted at rest),
 * then the directory is removed. Each session gets the files written into its own harness home, and when
 * the harness rewrites them (token refresh) the new contents go back to the vault, so the next session
 * starts with the current tokens. Your own login (~/.codex & co.) is never read or touched.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SecretStore } from '@beamhop/core';
import type { HomeLogin, LoginMethod } from '@beamhop/harness-catalog';

/** The vault value of a home login: the credential files, by path relative to the harness home. */
export interface HomeBlob {
  v: 1;
  files: Record<string, string>;
}

export const encodeBlob = (files: Record<string, string>): string => JSON.stringify({ v: 1, files });

export const decodeBlob = (value: string | undefined): HomeBlob | undefined => {
  if (!value) return undefined;
  try {
    const b = JSON.parse(value) as HomeBlob;
    return b && b.v === 1 && b.files && typeof b.files === 'object' ? b : undefined;
  } catch {
    return undefined;
  }
};

/** The home login of a method (throws if it is not one). */
export const homeOf = (m: LoginMethod): HomeLogin => {
  if (m.kind !== 'home' || !m.home) throw new Error(`${m.id} is not a subscription login`);
  return m.home;
};

/** Write the seed files (and the stored credential files, if any) into `dir`. */
export const writeHome = (dir: string, home: HomeLogin, blob?: HomeBlob): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const put = (rel: string, content: string, mode: number) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, content, { mode });
    chmodSync(p, mode);
  };
  for (const s of home.seed) if (!existsSync(join(dir, s.path))) put(s.path, s.content, 0o600);
  const allowed = new Set(home.files.flatMap((f) => f.split('|')));
  for (const [rel, content] of Object.entries(blob?.files ?? {}))
    if (allowed.has(rel)) put(rel, content, 0o600);
};

const readNonEmpty = (p: string): string | undefined => {
  try {
    const c = readFileSync(p, 'utf8');
    return c.trim() ? c : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The credential files in `dir`, or undefined unless every one exists and is non-empty. For `a|b`
 * entries the first that exists counts (and is stored under its own path).
 */
export const readHome = (dir: string, home: HomeLogin): Record<string, string> | undefined => {
  const files: Record<string, string> = {};
  for (const entry of home.files) {
    const hit = entry
      .split('|')
      .map((rel) => [rel, readNonEmpty(join(dir, rel))] as const)
      .find(([, c]) => c !== undefined);
    if (!hit) return undefined;
    files[hit[0]] = hit[1]!;
  }
  return files;
};

/**
 * Environment that points the harness at `dir`: the relocation variable, `extraEnv` (with `{home}`
 * replaced), and with a stored login `asEnv`'s variable set to that file's contents.
 */
export const homeEnv = (dir: string, home: HomeLogin, blob?: HomeBlob): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(home.extraEnv)) env[k] = v.replaceAll('{home}', dir);
  if (home.env) env[home.env] = dir;
  const value = home.asEnv && blob?.files[home.asEnv.file];
  if (home.asEnv && value) env[home.asEnv.var] = value.trim();
  return env;
};

/** `args` with `{home}` replaced by the login directory. */
export const homeArgs = (args: string[], dir: string): string[] =>
  args.map((a) => a.replaceAll('{home}', dir));

/**
 * Keep a session's copy of a home login in step with the vault: writes it into `dir` now, then saves
 * the files back whenever the harness changes them (checked every `intervalMs`, and on `stop`).
 */
/** Run the harness binary with an environment and capture stdout (never stored in job output or logs). */
export const runCapture = (
  bin: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 60_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      { env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
    );
  });

/** A `transfer` login: the credential as the harness exports it, or undefined if there is none. */
export const exportTransfer = async (
  bin: string,
  home: HomeLogin,
  dir: string,
  run = runCapture,
): Promise<Record<string, string> | undefined> => {
  const t = home.transfer;
  if (!t) return undefined;
  const r = await run(bin, homeArgs(t.exportArgs, dir), homeEnv(dir, home));
  const out = r.stdout.trim();
  if (r.code !== 0 || !out) return undefined;
  try {
    const v = JSON.parse(out) as unknown;
    if ((Array.isArray(v) && !v.length) || (v && typeof v === 'object' && !Object.keys(v).length))
      return undefined;
  } catch {
    return undefined;
  }
  return { [t.file]: `${out}\n` };
};

/** Load a `transfer` login into `dir` with the harness's import command (the temporary file is removed). */
export const importTransfer = async (
  bin: string,
  home: HomeLogin,
  dir: string,
  blob: HomeBlob,
  run = runCapture,
): Promise<void> => {
  const t = home.transfer;
  const content = t && blob.files[t.file];
  if (!t || !content) throw new Error('the stored sign-in is damaged; sign in again');
  const file = join(dir, t.file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { mode: 0o600 });
  try {
    const args = homeArgs(t.importArgs, dir).map((a) => a.replaceAll('{file}', file));
    const r = await run(bin, args, homeEnv(dir, home));
    if (r.code !== 0)
      throw new Error(`could not load the sign-in: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  } finally {
    rmSync(file, { force: true });
  }
};

/**
 * Keep a session's copy of a home login in step with the vault: writes it into `dir` now, then saves
 * the files back whenever the harness changes them (checked every `intervalMs`, and on `stop`).
 * `transfer` logins (OpenCode) are loaded and read back with the harness's own commands (`bin`).
 */
export class HomeLoginSync {
  private last: string;
  private timer: NodeJS.Timeout | undefined;
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    private readonly secrets: SecretStore,
    private readonly method: LoginMethod,
    private readonly dir: string,
    blob: HomeBlob,
    private readonly onError: (e: unknown) => void,
    private readonly bin: string | undefined,
  ) {
    this.last = encodeBlob(blob.files);
  }

  /** Write (or import) the login into `dir`. `bin`: the harness binary, needed for `transfer` logins. */
  static async open(
    secrets: SecretStore,
    method: LoginMethod,
    dir: string,
    blob: HomeBlob,
    opts: { bin?: string; onError?: (e: unknown) => void } = {},
  ): Promise<HomeLoginSync> {
    const home = homeOf(method);
    if (home.transfer) {
      if (!opts.bin) throw new Error('the harness is not installed');
      writeHome(dir, home);
      await importTransfer(opts.bin, home, dir, blob);
    } else writeHome(dir, home, blob);
    const sync = new HomeLoginSync(secrets, method, dir, blob, opts.onError ?? (() => {}), opts.bin);
    if (!home.transfer) sync.last = encodeBlob(readHome(dir, home) ?? blob.files);
    return sync;
  }

  /** Start watching (unref'd: never keeps the daemon alive). Exported logins are checked less often. */
  start(intervalMs = homeOf(this.method).transfer ? 600_000 : 30_000): this {
    this.timer = setInterval(() => void this.sync(), intervalMs);
    this.timer.unref?.();
    return this;
  }

  /** Save the files to the vault if the harness changed them. Never saves an incomplete set. */
  sync(): Promise<void> {
    this.saving = this.saving.then(async () => {
      const home = homeOf(this.method);
      const files = home.transfer
        ? this.bin
          ? await exportTransfer(this.bin, home, this.dir).catch(() => undefined)
          : undefined
        : readHome(this.dir, home);
      if (!files) return;
      const value = encodeBlob(files);
      if (value === this.last) return;
      try {
        await this.secrets.set(this.method.secret, value);
        this.last = value;
      } catch (e) {
        this.onError(e);
      }
    });
    return this.saving;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.sync();
  }
}
