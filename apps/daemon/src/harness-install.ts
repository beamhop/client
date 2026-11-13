/**
 * Job bodies for installing, updating and logging in harnesses (run by `HarnessJobs`). What runs comes
 * only from the catalog (validated package names, https installer URLs, pinned checksums), as argv.
 */
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { HarnessView } from '@beamhop/core';
import { nodeExecEnv } from '@beamhop/core';
import {
  type CatalogEntry,
  compareVersions,
  type LoginFlow,
  type LoginMethod,
  parseVersion,
} from '@beamhop/harness-catalog';
import {
  archiveFor,
  type InstallMethod,
  installCommand,
  isBrewPath,
  isManagedPath,
  isValidPackageName,
  managedHarnessDir,
  managedNpmPrefix,
  managedRoot,
  methodLabel,
  nativeFor,
} from '@beamhop/harness-discovery';
import { friendlyError, type JobBody, JobError, type JobRuntime } from './harness-jobs.ts';
import { PI_OAUTH_HELPER } from './pi-oauth-helper.ts';

export interface InstallerDeps {
  platform: NodeJS.Platform;
  arch: string;
  /** Environment for child processes (the daemon's own: the desktop app passes the login shell's PATH). */
  env: NodeJS.ProcessEnv;
  /** The user's home. */
  home: string;
  beamhopHome: string;
  which(cmd: string): string | undefined;
  fetch: typeof fetch;
  /** Open a URL in the default browser. */
  openUrl(url: string): void;
  /** Run a tool and capture its stdout (version lookups). */
  capture(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }>;
}

export const defaultInstallerDeps = (
  beamhopHome: string,
  env: NodeJS.ProcessEnv,
  which: (cmd: string) => string | undefined,
): InstallerDeps => ({
  platform: process.platform,
  arch: process.arch,
  env,
  home: homedir(),
  beamhopHome,
  which,
  fetch: (...a) => fetch(...a),
  openUrl: (url) => {
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '""', url.replace(/[&^|<>]/g, '^$&')]]
          : ['xdg-open', [url]];
    try {
      const c = nodeSpawn(cmd as string, args as string[], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      c.on('error', () => {});
      c.unref();
    } catch {
      /* the job still shows the URL */
    }
  },
  capture: (cmd, args, timeoutMs) =>
    new Promise((res) => {
      execFile(
        cmd,
        args,
        { env, timeout: timeoutMs, maxBuffer: 4 << 20, windowsHide: true },
        (err, stdout) => {
          const code = err
            ? typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : 1
            : 0;
          res({ code, stdout: String(stdout ?? '') });
        },
      );
    }),
});

const MAX_SCRIPT_BYTES = 5 << 20;
const MAX_ARCHIVE_BYTES = 1 << 30;

const tool = (deps: InstallerDeps, cmd: string): string => {
  const p = deps.which(cmd);
  if (!p)
    throw new JobError(
      cmd === 'brew'
        ? 'Homebrew was not found on this computer.'
        : cmd === 'npm'
          ? 'npm (Node.js) was not found on this computer.'
          : `${cmd} was not found on this computer.`,
    );
  return p;
};

/** A failed tool run, explained from its output when the cause is a common one. */
const exitError = (
  label: string,
  what: string,
  r: { code: number | null; signal: string | null },
  text: string,
) =>
  new JobError(
    friendlyError(text, what) ??
      (r.signal
        ? `${label} was stopped (${r.signal}).`
        : `${label} failed (exit code ${r.code}). See the details.`),
  );

/** Download `url` (https only) into `file`, hashing it. Returns the sha256 hex. */
const download = async (
  deps: InstallerDeps,
  rt: JobRuntime,
  url: string,
  file: string,
  maxBytes: number,
): Promise<string> => {
  if (!/^https:\/\//.test(url)) throw new JobError('Refusing to download from a non-https address.');
  rt.line(`Downloading ${url}`);
  const res = await deps.fetch(url, { redirect: 'follow', signal: rt.signal });
  if (res.url && !/^https:\/\//.test(res.url))
    throw new JobError('The download was redirected to a non-https address.');
  if (!res.ok || !res.body) throw new JobError(`The download failed (HTTP ${res.status}). Try again later.`);
  const hash = createHash('sha256');
  let size = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (c: Buffer) => {
    size += c.length;
    hash.update(c);
    if (size > maxBytes)
      body.destroy(new JobError('The download is larger than expected, so it was stopped.'));
  });
  await pipeline(body, createWriteStream(file, { mode: 0o600 }));
  return hash.digest('hex');
};

const assertInside = (root: string, p: string): string => {
  const r = resolve(root, p);
  if (r !== root && !r.startsWith(root + sep))
    throw new JobError('The installer archive has an unexpected layout.');
  return r;
};

/** Install or update `entry` with `method`; returns the success message. */
export const installBody =
  (
    entry: CatalogEntry,
    method: InstallMethod,
    update: boolean,
    deps: InstallerDeps,
    rescan: () => Promise<HarnessView | undefined>,
  ): JobBody =>
  async (rt) => {
    const label = methodLabel(entry, method);
    const what = update ? 'The update' : 'The install';
    rt.step('resolving', `Getting ready to ${update ? 'update' : 'install'} ${entry.displayName}…`);
    let cmd: ReturnType<typeof installCommand>;
    try {
      cmd = installCommand(entry, method, deps, update);
    } catch (e) {
      throw new JobError((e as Error).message);
    }
    rt.line(`$ ${cmd.display.join(' ')}`);
    const env = { ...deps.env, ...(cmd.env ?? {}) };

    if (method === 'npm' || method === 'brew' || method === 'winget') {
      const bin = tool(deps, method);
      if (method === 'npm') {
        const prefix = managedNpmPrefix(deps.beamhopHome, deps.platform);
        mkdirSync(prefix, { recursive: true, mode: 0o700 });
        const pkgDir =
          deps.platform === 'win32'
            ? join(prefix, 'node_modules', entry.install.npm!)
            : join(prefix, 'lib', 'node_modules', entry.install.npm!);
        if (!existsSync(pkgDir)) rt.onCleanup(() => removeNpmInstall(pkgDir, prefix, entry, deps.platform));
      }
      rt.step('installing', update ? `Updating with ${label}…` : `Installing with ${label}…`);
      const r = await rt.run(bin, cmd.argv.slice(1), { env });
      if (r.code !== 0) throw exitError(label, what, r, rt.text());
    } else {
      const n = nativeFor(entry, deps.platform);
      if (!n) throw new JobError(`${entry.displayName} has no installer for this computer.`);
      const tmp = mkdtempSync(join(tmpdir(), 'beamhop-install-'));
      rt.onCleanup(() => rmSync(tmp, { recursive: true, force: true }));
      try {
        if (n.kind === 'script') {
          const bash = tool(deps, 'bash');
          rt.step('downloading', `Downloading the ${label}…`);
          const file = join(tmp, 'install.sh');
          await download(deps, rt, n.url, file, MAX_SCRIPT_BYTES);
          rt.step('installing', `Running the ${label}…`);
          // Never sudo: the vendor script runs as the user, from a file (no pipe from the network).
          const r = await rt.run(bash, [file], { env, cwd: tmp });
          if (r.code !== 0) throw exitError(label, what, r, rt.text());
        } else {
          const a = archiveFor(n, deps.arch);
          if (!a)
            throw new JobError(`${entry.displayName} has no installer for this computer (${deps.arch}).`);
          rt.step('downloading', `Downloading ${entry.displayName}…`);
          const file = join(tmp, basename(new URL(a.url).pathname) || 'archive');
          const got = await download(deps, rt, a.url, file, MAX_ARCHIVE_BYTES);
          rt.step('verifying', 'Checking the download…');
          if (got !== a.sha256.toLowerCase()) {
            rt.line(`sha256 mismatch: expected ${a.sha256}, got ${got}`);
            throw new JobError(
              "The download didn't match its expected checksum, so nothing was installed. Try again later.",
            );
          }
          rt.step('installing', `Installing ${entry.displayName}…`);
          const root = managedRoot(deps.beamhopHome, deps.platform);
          mkdirSync(root, { recursive: true, mode: 0o700 });
          const staging = join(root, `.${entry.id}.partial-${randomBytes(4).toString('hex')}`);
          mkdirSync(staging, { mode: 0o700 });
          rt.onCleanup(() => rmSync(staging, { recursive: true, force: true }));
          const r = await rt.run(tool(deps, 'tar'), ['-xf', file, '-C', staging], { env });
          if (r.code !== 0) throw exitError(label, what, r, rt.text());
          const binPath = assertInside(staging, n.bin);
          if (!existsSync(binPath)) throw new JobError('The installer archive has an unexpected layout.');
          if (deps.platform !== 'win32') chmodSync(binPath, 0o755);
          linkBinary(staging, n.bin, entry.binaries[0]!, deps.platform);
          const final = managedHarnessDir(deps.beamhopHome, entry.id, deps.platform);
          const old = `${final}.old-${randomBytes(4).toString('hex')}`;
          if (existsSync(final)) renameSync(final, old);
          renameSync(staging, final);
          rmSync(old, { recursive: true, force: true });
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }

    rt.step('checking', `Checking ${entry.displayName}…`);
    const v = await rescan();
    if (!v || v.status === 'not-installed')
      throw new JobError(
        `${label} finished, but beamhop can't find ${entry.displayName}. It may have been installed somewhere beamhop doesn't look; restart beamhop and check again.`,
      );
    return `${update ? 'Updated' : 'Installed'} ${entry.displayName}${v.version ? ` ${v.version}` : ''} via ${label}.`;
  };

/** Make `<dir>/bin/<name>` point at the archive's binary, so discovery finds it. */
const linkBinary = (dir: string, bin: string, name: string, platform: NodeJS.Platform) => {
  const norm = bin.replace(/\\/g, '/');
  if (norm === name || norm === `bin/${name}` || (platform === 'win32' && /^(bin\/)?[^/]+\.exe$/i.test(norm)))
    return;
  mkdirSync(join(dir, 'bin'), { recursive: true });
  if (platform === 'win32') {
    writeFileSync(join(dir, 'bin', `${name}.cmd`), `@"%~dp0\\..\\${bin.replace(/\//g, '\\')}" %*\r\n`);
    return;
  }
  symlinkSync(relative(join(dir, 'bin'), join(dir, bin)), join(dir, 'bin', name));
};

/** Undo a half-finished npm install into beamhop's prefix (only what this job added). */
const removeNpmInstall = (pkgDir: string, prefix: string, entry: CatalogEntry, platform: NodeJS.Platform) => {
  rmSync(pkgDir, { recursive: true, force: true });
  if (platform === 'win32') return;
  for (const b of entry.binaries) {
    const shim = join(prefix, 'bin', b);
    try {
      if (!lstatSync(shim).isSymbolicLink()) continue;
      const target = resolve(dirname(shim), readlinkSync(shim));
      if (target.startsWith(pkgDir + sep) || !existsSync(target)) rmSync(shim, { force: true });
    } catch {
      /* absent */
    }
  }
};

// ───────────────────────────── updates ─────────────────────────────

/** How an installed harness can be updated by beamhop (only its own installs and Homebrew's). */
export const updateMethodFor = (
  view: Pick<HarnessView, 'path'>,
  entry: CatalogEntry,
  deps: Pick<InstallerDeps, 'beamhopHome' | 'platform' | 'which'>,
): InstallMethod | undefined => {
  const p = view.path;
  if (!p) return undefined;
  if (isManagedPath(p, deps.beamhopHome, deps.platform)) {
    const npm = managedNpmPrefix(deps.beamhopHome, deps.platform);
    return p.startsWith(npm + (deps.platform === 'win32' ? '\\' : '/')) ? 'npm' : 'native';
  }
  let real = p;
  try {
    real = realpathSync(p);
  } catch {
    /* keep p */
  }
  if (
    deps.platform !== 'win32' &&
    entry.install.brew &&
    (isBrewPath(p) || isBrewPath(real)) &&
    deps.which('brew')
  )
    return 'brew';
  if (deps.platform === 'win32' && entry.install.winget && /\\WinGet\\/i.test(p) && deps.which('winget'))
    return 'winget';
  return undefined;
};

/** Latest published version for an update method (undefined: unknown). */
export const latestVersion = async (
  entry: CatalogEntry,
  method: InstallMethod | undefined,
  deps: Pick<InstallerDeps, 'which' | 'capture'>,
): Promise<string | undefined> => {
  const via = method ?? (entry.install.npm ? 'npm' : undefined);
  if (via === 'npm' && entry.install.npm && isValidPackageName('npm', entry.install.npm)) {
    const npm = deps.which('npm');
    if (!npm) return undefined;
    const r = await deps.capture(npm, ['view', entry.install.npm, 'version'], 30_000);
    const v = r.code === 0 ? parseVersion(r.stdout.trim()) : undefined;
    return v?.join('.');
  }
  if (via === 'brew' && entry.install.brew && isValidPackageName('brew', entry.install.brew)) {
    const brew = deps.which('brew');
    if (!brew) return undefined;
    const r = await deps.capture(brew, ['info', '--json=v2', entry.install.brew], 30_000);
    if (r.code !== 0) return undefined;
    try {
      const j = JSON.parse(r.stdout) as {
        formulae?: { versions?: { stable?: string } }[];
        casks?: { version?: string }[];
      };
      const raw = j.formulae?.[0]?.versions?.stable ?? j.casks?.[0]?.version;
      return raw ? (parseVersion(raw)?.join('.') ?? raw) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

export const isNewer = (latest: string | undefined, current: string | undefined): boolean => {
  const l = latest ? parseVersion(latest) : undefined;
  const c = current ? parseVersion(current) : undefined;
  return !!l && !!c && compareVersions(l, c) > 0;
};

// ───────────────────────────── logins ─────────────────────────────

const URL_RE = /https:\/\/[^\s"'<>`\]]+/;
const CODE_RE = /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/;

/** The first https URL and a device code (e.g. ABCD-1234) in a line of login output. */
export const parseLoginLine = (line: string): { url?: string; code?: string } => {
  const out: { url?: string; code?: string } = {};
  const u = URL_RE.exec(line)?.[0]?.replace(/[).,;:!?'"]+$/, '');
  if (u) out.url = u;
  const code = CODE_RE.exec(line.replace(new RegExp(URL_RE.source, 'g'), ' '))?.[0];
  if (code) out.code = code;
  return out;
};

const shQuote = (s: string): string =>
  /^[A-Za-z0-9_./=:@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * argv that runs `bin args…` under a pseudo-terminal using the system `script` command (wide, so long
 * URLs and tokens are not wrapped). Without `script` (Windows), it runs directly.
 */
export const ptyArgv = (
  platform: NodeJS.Platform,
  script: string | undefined,
  bin: string,
  args: string[],
): { cmd: string; args: string[] } => {
  if (!script || platform === 'win32') return { cmd: bin, args };
  // `$0`/`$@` keep the harness's argv out of the shell's parsing.
  const inner = ['sh', '-c', 'stty cols 1000 rows 50 2>/dev/null; exec "$0" "$@"', bin, ...args];
  if (platform === 'darwin') return { cmd: script, args: ['-q', '/dev/null', ...inner] };
  return { cmd: script, args: ['-qefc', inner.map(shQuote).join(' '), '/dev/null'] };
};

export interface LoginHooks {
  /** The harness binary to run. */
  binary: string;
  /** Store a captured credential as vault login `method` (same path as `harness.login`). */
  storeLogin(method: string, value: string): Promise<void>;
  /** The harness's own login check after the command exits (auth files). */
  loggedIn(): boolean;
}

/** Run the harness's own login without a terminal; returns the success message. */
export const loginBody =
  (
    entry: CatalogEntry,
    flow: LoginFlow,
    deps: InstallerDeps,
    hooks: LoginHooks,
    openBrowser: boolean,
  ): JobBody =>
  async (rt) => {
    rt.step('resolving', `Starting ${entry.displayName} sign-in…`);
    const capture = flow.capture ? new RegExp(flow.capture.pattern) : undefined;
    if (capture) rt.redactPattern(capture);
    let opened = false;
    let captured: string | undefined;
    let storing: Promise<void> | undefined;
    const pty = ptyArgv(deps.platform, deps.which('script'), hooks.binary, flow.args);
    const r = await rt.run(pty.cmd, pty.args, {
      env: {
        ...deps.env,
        TERM: deps.env.TERM && deps.env.TERM !== 'dumb' ? deps.env.TERM : 'xterm-256color',
      },
      // macOS `script` can't use a socket as stdin (tcgetattr fails), so it gets /dev/null there; util-linux
      // `script` gets an open pipe so it never sees EOF.
      stdin: deps.platform === 'darwin' ? 'ignore' : 'pipe',
      onLine: (line) => {
        if (capture && !captured) {
          const m = capture.exec(line)?.[0];
          if (m) {
            captured = m;
            rt.redact(m);
            rt.step('checking', 'Saving the sign-in…');
            storing = hooks.storeLogin(flow.capture!.method, m).finally(() => rt.stopChild());
            return;
          }
        }
        const p = parseLoginLine(line);
        if (p.url && !rt.signal.aborted) {
          if (!opened) {
            opened = true;
            rt.set({ url: p.url });
            rt.step('waiting-browser', 'Continue in your browser.');
            if (openBrowser) deps.openUrl(p.url);
          }
        }
        if (p.code && flow.kind === 'device-code') rt.set({ code: p.code });
      },
    });
    if (captured) {
      await storing;
      return `Signed in to ${entry.displayName}.`;
    }
    if (capture) throw new JobError('The sign-in ended before it finished. Try again.');
    rt.step('checking', 'Checking the sign-in…');
    if (r.code === 0 && hooks.loggedIn()) return `Signed in to ${entry.displayName}.`;
    throw new JobError(
      r.code === 0
        ? `The sign-in ended, but ${entry.displayName} doesn't look signed in. Try again.`
        : `The sign-in didn't finish (exit code ${r.code ?? r.signal}). Try again.`,
    );
  };

export interface HomeSignInHooks {
  binary: string;
  /** Fresh directory the harness signs in to (removed afterwards by the caller). */
  dir: string;
  /**
   * The credential files once they all exist, else undefined. `final`: the sign-in has ended (logins kept
   * in a database are only exported then).
   */
  read(final: boolean): Record<string, string> | undefined | Promise<Record<string, string> | undefined>;
  /** Store them in the vault (and check). */
  store(files: Record<string, string>): Promise<void>;
}

/** Stand-ins for `open`/`xdg-open` that print the page instead of opening it (see SignIn.captureOpen). */
export const OPEN_SHIM =
  '#!/bin/sh\nfor a in "$@"; do case "$a" in http*) echo "Open this page: $a";; esac; done\nexit 0\n';

const writeOpenShims = (dir: string): string => {
  const bin = join(dir, '.beamhop-open');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  for (const name of ['open', 'xdg-open']) writeFileSync(join(bin, name), OPEN_SHIM, { mode: 0o700 });
  return bin;
};

/** A JSON-RPC response line (`{"jsonrpc":"2.0","id":…}`), else undefined. */
const rpcResponse = (
  line: string,
): { id?: unknown; result?: unknown; error?: { message?: string } } | undefined => {
  const t = line.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    const m = JSON.parse(t) as { jsonrpc?: string; id?: unknown; method?: string };
    return m.jsonrpc === '2.0' && m.id !== undefined && m.method === undefined ? m : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Sign in to a subscription login (`home` method): run the harness's own sign-in with its home pointed
 * at `hooks.dir`, wait until the credential files exist (some sign-ins keep running afterwards, so the
 * child is stopped then), and hand them to `store`.
 */
export const homeSignInBody =
  (
    entry: CatalogEntry,
    method: LoginMethod,
    deps: InstallerDeps,
    hooks: HomeSignInHooks,
    env: Record<string, string>,
    openBrowser: boolean,
  ): JobBody =>
  async (rt) => {
    const signIn = method.signIn!;
    rt.step('resolving', `Starting ${method.label} sign-in for ${entry.displayName}…`);
    const headless = !openBrowser && (!!signIn.headlessArgs || !!signIn.helper);
    const args = (headless ? signIn.headlessArgs! : signIn.args).map((a) =>
      a.replaceAll('{home}', hooks.dir),
    );
    const childEnv: NodeJS.ProcessEnv = {
      ...deps.env,
      ...env,
      TERM: deps.env.TERM && deps.env.TERM !== 'dumb' ? deps.env.TERM : 'xterm-256color',
    };
    if (signIn.captureOpen && deps.platform !== 'win32')
      childEnv.PATH = `${writeOpenShims(hooks.dir)}:${childEnv.PATH ?? ''}`;
    let opened = false;
    let files: Record<string, string> | undefined;
    const poll = setInterval(() => {
      if (files) return;
      const now = hooks.read(false);
      files = now instanceof Promise ? undefined : now;
      if (files) {
        rt.step('checking', 'Saving the sign-in…');
        // Let the harness finish writing, then stop it if it is still waiting for input.
        setTimeout(() => rt.stopChild(), 1500).unref?.();
      }
    }, 1000);
    poll.unref?.();
    rt.onCleanup(() => clearInterval(poll));

    // JSON-RPC sign-in (ACP): send the requests one after another, finish when the last one answers.
    const rpc = signIn.rpc;
    let write: ((text: string) => void) | undefined;
    let next = 0;
    let rpcError: string | undefined;
    const send = () => {
      const req = rpc?.[next];
      if (!req || !write) return;
      write(
        `${JSON.stringify({ jsonrpc: '2.0', id: next + 1, method: req.method, params: req.params ?? {} })}\n`,
      );
    };

    const onLine = (line: string) => {
      if (rpc) {
        const res = rpcResponse(line);
        if (res && res.id === next + 1) {
          if (res.error) {
            rpcError = res.error.message ?? 'the sign-in was refused';
            rt.stopChild();
            return;
          }
          next += 1;
          if (next < rpc.length) send();
          else setTimeout(() => rt.stopChild(), 1500).unref?.();
          return;
        }
      }
      const p = parseLoginLine(line);
      if (p.url && !opened && !rt.signal.aborted) {
        opened = true;
        rt.set({ url: p.url });
        rt.step('waiting-browser', 'Continue in your browser.');
        if (openBrowser) deps.openUrl(p.url);
      }
      if (p.code && (headless || /code/i.test(line))) rt.set({ code: p.code });
    };

    let r: Awaited<ReturnType<typeof rt.run>>;
    try {
      if (rpc) {
        r = await rt.run(hooks.binary, args, {
          env: childEnv,
          stdin: 'pipe',
          onLine,
          onStart: (w) => {
            write = w;
            send();
          },
        });
      } else if (signIn.helper) {
        // The harness's own sign-in code, run by a helper on the daemon's runtime (no terminal).
        const helper = join(hooks.dir, '.beamhop-signin.mjs');
        writeFileSync(helper, PI_OAUTH_HELPER, { mode: 0o600 });
        const authFile = join(hooks.dir, (method.home!.files[0] ?? 'auth.json').split('|')[0]!);
        r = await rt.run(
          process.execPath,
          [
            helper,
            hooks.binary,
            signIn.helper.provider,
            headless || !openBrowser ? 'device' : 'browser',
            authFile,
          ],
          { env: { ...childEnv, ...nodeExecEnv() }, onLine },
        );
      } else {
        const pty = ptyArgv(deps.platform, deps.which('script'), hooks.binary, args);
        r = await rt.run(pty.cmd, pty.args, {
          env: childEnv,
          stdin: deps.platform === 'darwin' ? 'ignore' : 'pipe',
          onLine,
        });
      }
    } finally {
      clearInterval(poll);
    }
    if (!files && !rpcError && (r.code === 0 || (rpc && next >= rpc.length))) files = await hooks.read(true);
    files ??= undefined;
    if (!files)
      throw new JobError(
        rpcError
          ? `${entry.displayName} refused the sign-in: ${rpcError}`
          : r.code === 0 || (rpc && next >= rpc.length)
            ? `The sign-in ended, but ${entry.displayName} didn't save a login. Try again.`
            : `The sign-in didn't finish (exit code ${r.code ?? r.signal}). Try again.`,
      );
    rt.step('checking', 'Saving the sign-in…');
    await hooks.store(files);
    return `Signed in to ${entry.displayName} with ${method.label}.`;
  };
