/**
 * Daemon supervision for the desktop app. No Electron imports, so it is unit-testable with a fake
 * daemon script.
 *
 * One daemon per beamhop home: if one already answers on the configured URL (started by the CLI, a
 * login service, or another copy of the app) the app attaches to it and never stops it. Otherwise
 * the app starts its own bundled daemon, restarts it if it crashes, and stops it when the app quits.
 */
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
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
  fetch?: typeof fetch;
  spawn?: typeof nodeSpawn;
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
  return 'The beamhop daemon did not start.';
};

export class DaemonSupervisor extends EventEmitter<SupervisorEvents> {
  private _state: DaemonState = 'idle';
  private child: ChildProcess | undefined;
  private poll: NodeJS.Timeout | undefined;
  private crashes: number[] = [];
  private wantRunning = false;
  private readonly o: Required<Omit<SupervisorOptions, 'fetch' | 'spawn'>> &
    Pick<SupervisorOptions, 'fetch' | 'spawn'>;
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
    return this.child !== undefined;
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
    const f = this.o.fetch ?? fetch;
    try {
      const res = await f(`${this.o.url}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: unknown };
      return body.ok === true;
    } catch {
      return false;
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

  /** Attach to a running daemon or start the bundled one. Resolves once the API answers. */
  async ensure(): Promise<'external' | 'owned'> {
    this.wantRunning = true;
    this.lastError = undefined;
    if (this.child) {
      if (await this.healthy()) return 'owned';
    } else if (await this.healthy()) {
      this.set('external');
      this.startPolling();
      return 'external';
    }
    await this.spawnDaemon();
    return 'owned';
  }

  private async spawnDaemon(): Promise<void> {
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
      if (exited) break;
      if (await this.healthy(1000)) {
        this.set('running');
        this.startPolling();
        return;
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
    this.set('stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.ensure();
  }
}
