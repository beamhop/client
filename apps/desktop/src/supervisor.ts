/**
 * Daemon supervision for the desktop app. No Electron imports, so it is unit-testable with a fake
 * daemon script.
 *
 * One daemon per beamhop home: if one already answers on the configured URL (started by the CLI, a
 * login service, or another copy of the app) the app attaches to it and never stops it. Otherwise
 * the app starts its own bundled daemon, restarts it if it crashes, and stops it when the app quits.
 *
 * A daemon the app started is recorded in `markerFile` (pid + build). If the app was killed or replaced
 * while running, that daemon outlives it; the next launch finds the marker and either adopts it (same
 * build: it is stopped on quit again) or replaces it (another build: an updated app never keeps talking
 * to the old daemon).
 */
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type DaemonState = 'idle' | 'starting' | 'running' | 'external' | 'stopping' | 'stopped' | 'failed';

export interface SupervisorOptions {
  /** Daemon base URL, e.g. http://127.0.0.1:7878 */
  url: string;
  /** How to start the bundled daemon. */
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** API token file (`<home>/api-token`). */
  tokenFile: string;
  /** stdout/stderr of the owned daemon (appended). */
  logFile: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Health poll interval while running. */
  pollMs?: number;
  /** Crash restarts allowed within `restartWindowMs` before giving up. */
  maxRestarts?: number;
  restartWindowMs?: number;
  /** Where the app records the daemon it started (`<home>/desktop-daemon.json`). */
  markerFile?: string;
  /** Identifies this app's bundled daemon (changes with every build). */
  buildId?: string;
  fetch?: typeof fetch;
  spawn?: typeof nodeSpawn;
  /** Signal a process (tests pass a fake); `signal 0` checks it is alive. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

interface DaemonMarker {
  pid: number;
  build: string;
  startedAt: string;
}

export interface SupervisorEvents {
  state: [DaemonState];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Last `n` lines of a log file, for error messages. */
export const tailFile = (file: string, n = 12): string => {
  try {
    return readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-n).join('\n');
  } catch {
    return '';
  }
};

/** Turn a daemon start failure into one sentence a user can act on. */
export const explainStartFailure = (log: string, url: string): string => {
  if (/EADDRINUSE|address already in use/i.test(log))
    return `Another program is using ${new URL(url).host}. Quit it, or set BEAMHOP_PORT to a free port.`;
  if (/another beamhop daemon is running/i.test(log))
    return 'A beamhop daemon for this home is already running on a different port. Stop it, or point the app at it with BEAMHOP_PORT.';
  // beamhopd prints its fatal error as `beamhopd: <message>`; the last one is this start's.
  const fatal = log
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith('beamhopd: '));
  if (fatal) return `The beamhop daemon did not start: ${fatal.slice('beamhopd: '.length)}`;
  return 'The beamhop daemon did not start.';
};

export class DaemonSupervisor extends EventEmitter<SupervisorEvents> {
  private _state: DaemonState = 'idle';
  private child: ChildProcess | undefined;
  private poll: NodeJS.Timeout | undefined;
  private crashes: number[] = [];
  private wantRunning = false;
  /** A daemon an earlier run of this app started and this run adopted (no ChildProcess handle). */
  private adoptedPid: number | undefined;
  private readonly o: Required<
    Omit<SupervisorOptions, 'fetch' | 'spawn' | 'kill' | 'markerFile' | 'buildId'>
  > &
    Pick<SupervisorOptions, 'fetch' | 'spawn' | 'kill' | 'markerFile' | 'buildId'>;
  lastError: string | undefined;

  constructor(opts: SupervisorOptions) {
    super();
    this.o = {
      startTimeoutMs: 30_000,
      stopTimeoutMs: 20_000,
      pollMs: 5_000,
      maxRestarts: 3,
      restartWindowMs: 60_000,
      ...opts,
    };
  }

  get state(): DaemonState {
    return this._state;
  }

  /** True when this app started the daemon (and will stop it on quit). */
  get owned(): boolean {
    return this.child !== undefined || this.adoptedPid !== undefined;
  }

  private signal(pid: number, sig: NodeJS.Signals | 0): boolean {
    try {
      (this.o.kill ?? ((p, s) => process.kill(p, s)))(pid, sig);
      return true;
    } catch {
      return false;
    }
  }

  private readMarker(): DaemonMarker | undefined {
    if (!this.o.markerFile) return undefined;
    try {
      const m = JSON.parse(readFileSync(this.o.markerFile, 'utf8')) as DaemonMarker;
      return typeof m.pid === 'number' && typeof m.build === 'string' ? m : undefined;
    } catch {
      return undefined;
    }
  }

  private writeMarker(pid: number | undefined): void {
    if (!this.o.markerFile || !pid) return;
    try {
      mkdirSync(dirname(this.o.markerFile), { recursive: true });
      const m: DaemonMarker = { pid, build: this.o.buildId ?? '', startedAt: new Date().toISOString() };
      writeFileSync(this.o.markerFile, `${JSON.stringify(m)}\n`, { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  private clearMarker(): void {
    if (this.o.markerFile) rmSync(this.o.markerFile, { force: true });
  }

  /** Stop a daemon by pid (one we have no handle for) and wait until the API is gone. */
  private async stopPid(pid: number): Promise<void> {
    this.signal(pid, 'SIGTERM');
    const deadline = Date.now() + this.o.stopTimeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.healthy(500))) return;
      await sleep(200);
    }
    this.signal(pid, 'SIGKILL');
    await sleep(300);
  }

  get url(): string {
    return this.o.url;
  }

  private set(state: DaemonState): void {
    if (state === this._state) return;
    this._state = state;
    this.emit('state', state);
  }

  /** Does a beamhop daemon answer on the URL? */
  async healthy(timeoutMs = 1500): Promise<boolean> {
    return (await this.health(timeoutMs)) !== undefined;
  }

  /** The answering daemon (`pid` when it reports one; older daemons do not), or undefined if none answers. */
  private async health(timeoutMs = 1500): Promise<{ pid?: number } | undefined> {
    const f = this.o.fetch ?? fetch;
    try {
      const res = await f(`${this.o.url}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { ok?: unknown; pid?: unknown };
      if (body.ok !== true) return undefined;
      return typeof body.pid === 'number' ? { pid: body.pid } : {};
    } catch {
      return undefined;
    }
  }

  token(): string {
    const t = readFileSync(this.o.tokenFile, 'utf8').trim();
    if (!t) throw new Error(`empty API token file ${this.o.tokenFile}`);
    return t;
  }

  /** URL that opens the web UI already signed in. The PWA moves the token to storage and strips it. */
  uiUrl(): string {
    return `${this.o.url}/#token=${this.token()}`;
  }

  private ensuring: Promise<'external' | 'owned'> | undefined;

  /**
   * Attach to a running daemon or start the bundled one. Resolves once the API answers. Calls that overlap
   * share one attempt, so two callers never start two daemons.
   */
  ensure(): Promise<'external' | 'owned'> {
    this.ensuring ??= this.ensureOnce().finally(() => {
      this.ensuring = undefined;
    });
    return this.ensuring;
  }

  private async ensureOnce(): Promise<'external' | 'owned'> {
    this.wantRunning = true;
    this.lastError = undefined;
    if (this.child) {
      if (await this.healthy()) return 'owned';
    } else if (await this.healthy()) {
      // Left over from an earlier run of the app (it was killed or replaced while running)?
      const m = this.readMarker();
      if (m && this.signal(m.pid, 0)) {
        if (this.o.buildId && m.build !== this.o.buildId) {
          // Another build: replace it, so an updated app never talks to the old daemon.
          await this.stopPid(m.pid);
          this.clearMarker();
        } else {
          this.adoptedPid = m.pid;
          this.set('running');
          this.startPolling();
          return 'owned';
        }
      } else {
        this.set('external');
        this.startPolling();
        return 'external';
      }
    }
    return this.spawnDaemon();
  }

  private async spawnDaemon(): Promise<'external' | 'owned'> {
    this.set('starting');
    mkdirSync(dirname(this.o.logFile), { recursive: true });
    const fd = openSync(this.o.logFile, 'a', 0o600);
    const spawn = this.o.spawn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawn(this.o.command, this.o.args, {
        env: this.o.env,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
    } finally {
      closeSync(fd);
    }
    this.child = child;
    let exited = false;
    child.once('exit', (code, signal) => {
      exited = true;
      if (this.child === child) this.child = undefined;
      this.onChildExit(code, signal);
    });
    child.once('error', (e) => {
      this.lastError = e.message;
    });

    const deadline = Date.now() + this.o.startTimeoutMs;
    while (Date.now() < deadline) {
      const h = await this.health(1000);
      if (exited) {
        if (!h) break;
        // Ours could not listen because another daemon (the CLI's, another app copy's) took the port
        // meanwhile. Never record that one as ours: attach to it as an external daemon.
        this.set('external');
        this.startPolling();
        return 'external';
      }
      // Ours is up, unless the answer comes from another daemon (ours is then about to exit).
      if (h && (h.pid === undefined || h.pid === child.pid)) {
        this.writeMarker(child.pid);
        this.set('running');
        this.startPolling();
        return 'owned';
      }
      await sleep(250);
    }
    const log = tailFile(this.o.logFile);
    if (!exited) child.kill('SIGKILL');
    this.child = undefined;
    this.wantRunning = false;
    this.lastError = `${explainStartFailure(log, this.o.url)}${log ? `\n\n${log}` : ''}`;
    this.set('failed');
    throw new Error(this.lastError);
  }

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.stopPolling();
    if (!this.wantRunning || this._state === 'stopping' || this._state === 'starting') return;
    // Unexpected exit: restart a few times, then give up and say why.
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < this.o.restartWindowMs), now];
    if (this.crashes.length > this.o.maxRestarts) {
      this.wantRunning = false;
      const log = tailFile(this.o.logFile);
      this.lastError = `The beamhop daemon keeps stopping (exit ${code ?? signal}).${log ? `\n\n${log}` : ''}`;
      this.set('failed');
      return;
    }
    void this.spawnDaemon().catch(() => {
      /* state + lastError already set */
    });
  }

  private startPolling(): void {
    this.stopPolling();
    this.poll = setInterval(() => void this.check(), this.o.pollMs);
    this.poll.unref();
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  /** Periodic health check: notices an external daemon going away (and starts ours in its place). */
  private async check(): Promise<void> {
    if (this._state !== 'external' && this._state !== 'running') return;
    const ok = await this.healthy();
    if (ok) return;
    if (this.adoptedPid !== undefined && this.wantRunning) {
      this.adoptedPid = undefined;
      this.clearMarker();
      this.stopPolling();
      await this.spawnDaemon().catch(() => undefined);
      return;
    }
    if (this._state === 'external' && this.wantRunning) {
      this.stopPolling();
      await this.spawnDaemon().catch(() => undefined);
    }
  }

  /** Stop the daemon if this app owns it. An external daemon is left alone. */
  async stop(): Promise<void> {
    this.wantRunning = false;
    this.stopPolling();
    const child = this.child;
    if (!child && this.adoptedPid !== undefined) {
      this.set('stopping');
      await this.stopPid(this.adoptedPid);
      this.adoptedPid = undefined;
      this.clearMarker();
      this.set('stopped');
      return;
    }
    if (!child) {
      if (this._state === 'external') this.set('stopped');
      return;
    }
    this.set('stopping');
    const exited = new Promise<void>((r) => {
      if (child.exitCode !== null || child.signalCode !== null) r();
      else child.once('exit', () => r());
    });
    // Windows has no SIGTERM: Node maps it to TerminateProcess, which is what we can do there.
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), this.o.stopTimeoutMs);
    await exited;
    clearTimeout(timer);
    this.child = undefined;
    this.clearMarker();
    this.set('stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.ensure();
  }
}
