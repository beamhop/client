/**
 * Harness jobs: installs, updates and logins the daemon runs for the desktop app (`harness.install`,
 * `harness.update`, `harness.loginFlow`). Clients poll `harness.job.get`, so a job survives a reload.
 *
 * - One active job per harness.
 * - Children run detached in their own process group; cancel kills the whole group and runs the job's
 *   cleanups (e.g. removing a half-unpacked install).
 * - Output is kept as lines (ANSI stripped, capped), with registered secrets redacted before storing.
 * - Finished jobs are kept for an hour.
 */
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { BeamhopError, type HarnessJob, type HarnessJobStep, isJobFinished } from '@beamhop/core';

export const MAX_JOB_LINES = 2000;
export const JOB_RETENTION_MS = 60 * 60 * 1000;
const KILL_GRACE_MS = 3000;

/** The part of a ChildProcess the job runner uses (tests pass fakes). */
export interface ChildLike {
  pid?: number | undefined;
  stdout: Readable | null;
  stderr: Readable | null;
  /** Open with `stdin: 'pipe'`. */
  stdin?: { write(chunk: string): unknown } | null;
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnOpts {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** `pipe`: keep stdin open (pseudo-terminal logins). Default `ignore`: a prompt fails instead of hanging. */
  stdin?: 'pipe' | 'ignore';
}
export type SpawnFn = (cmd: string, args: string[], opts: SpawnOpts) => ChildLike;

/** Real spawn: argv only (no shell), own process group on POSIX. */
export const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, {
    env: opts.env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    shell: false,
  }) as ChildProcess as ChildLike;

/** Kill a child and everything it started. */
export const killTree = (child: ChildLike, signal: NodeJS.Signals = 'SIGTERM'): void => {
  const pid = child.pid;
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      /* not a group leader (fake / already gone): fall through */
    }
  }
  if (pid && process.platform === 'win32') {
    try {
      nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* gone */
  }
};

// ───────────────────────────── text ─────────────────────────────

const ESC = '\u001b';
const BEL = '\u0007';
/** CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC strings, and two-byte escapes. */
const ANSI_RE = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[PX^_][^${ESC}]*${ESC}\\\\|${ESC}[@-Z\\\\-_]`,
  'g',
);
// biome-ignore lint/suspicious/noControlCharactersInRegex: dropping leftover control characters
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Plain text from terminal output (macOS `script` also echoes the EOF it forwards as "^D\b\b"). */
export const stripAnsi = (s: string): string =>
  s.split('^D\b\b').join('').replace(ANSI_RE, '').replace(CTRL_RE, '');

/** Plain-language explanation of a failed install/update from its output. */
export const friendlyError = (text: string, what = 'The install'): string | undefined => {
  if (/already running|has already locked|another active homebrew|waiting for another/i.test(text))
    return 'Homebrew is busy with another install. Try again in a minute.';
  if (/checksum|sha256 mismatch|sha-?256 does not match/i.test(text))
    return "The download didn't match its expected checksum, so nothing was installed. Try again later.";
  if (
    /E404|404 Not Found|is not in this registry|No available formula|No formulae or casks found/i.test(text)
  )
    return "The package manager couldn't find this harness's package. The catalog entry may be out of date.";
  if (/EACCES|EPERM|permission denied|operation not permitted/i.test(text))
    return `${what} needs to write somewhere beamhop isn't allowed to. Nothing was changed for other users.`;
  if (/ENOSPC|no space left/i.test(text)) return 'The disk is full. Free some space and try again.';
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|could not resolve host|network is unreachable|fetch failed|unable to access/i.test(
      text,
    )
  )
    return "Couldn't reach the internet. Check the connection and try again.";
  if (/timed out|timeout/i.test(text)) return 'It took too long and was stopped. Try again.';
  return undefined;
};

/** A failure whose message is already plain language. */
export class JobError extends Error {}
class JobCancelled extends Error {}

// ───────────────────────────── jobs ─────────────────────────────

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunOpts {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdin?: 'pipe' | 'ignore';
  /** Called with each output line (ANSI stripped, not yet redacted) before it is stored. */
  onLine?: (line: string) => void;
  /** With `stdin: 'pipe'`: called once the child runs, with a writer for its stdin. */
  onStart?: (write: (text: string) => void) => void;
}

/** What a job body gets to work with. */
export interface JobRuntime {
  readonly id: string;
  readonly signal: AbortSignal;
  step(step: Exclude<HarnessJobStep, 'done' | 'failed' | 'cancelled'>, message?: string): void;
  set(fields: { url?: string; code?: string; method?: HarnessJob['method'] }): void;
  /** Add an output line (redacted). */
  line(text: string): void;
  /** Never store `value` in output lines. */
  redact(value: string): void;
  /** Never store matches of `re` in output lines. */
  redactPattern(re: RegExp): void;
  run(cmd: string, args: string[], opts?: RunOpts): Promise<RunResult>;
  /** Stop the running child (the job continues; e.g. a login that already got its token). */
  stopChild(): void;
  /** Runs if the job is cancelled or fails (newest first). */
  onCleanup(fn: () => void | Promise<void>): void;
  /** The output so far, for error mapping. */
  text(): string;
}

interface JobState {
  view: HarnessJob;
  lines: string[];
  dropped: number;
  partial: Map<Readable, string>;
  secrets: Set<string>;
  patterns: RegExp[];
  child?: ChildLike;
  abort: AbortController;
  cleanups: (() => void | Promise<void>)[];
  finishedAt?: number;
  timer?: NodeJS.Timeout;
  onEnd?: (job: HarnessJob, lines: string[]) => void;
}

export interface HarnessJobsDeps {
  spawn?: SpawnFn;
  kill?: (child: ChildLike, signal?: NodeJS.Signals) => void;
  now?: () => number;
  /** Called on every job change (e.g. to emit an event). */
  onChange?: (job: HarnessJob) => void;
}

export interface StartOpts {
  harness: string;
  displayName?: string;
  kind: HarnessJob['kind'];
  method?: HarnessJob['method'];
  /** Fail the job after this long. */
  timeoutMs?: number;
  /** Describes the work in failure messages ("The install", "The update", "The login"). */
  what?: string;
  /** Called once when the job ends (done, failed or cancelled). */
  onEnd?: (job: HarnessJob, lines: string[]) => void;
}

/** Body of a job: returns the success message. */
export type JobBody = (rt: JobRuntime) => Promise<string | undefined>;

export class HarnessJobs {
  private readonly jobs = new Map<string, JobState>();
  private readonly spawn: SpawnFn;
  private readonly kill: (child: ChildLike, signal?: NodeJS.Signals) => void;
  private readonly now: () => number;

  constructor(private readonly deps: HarnessJobsDeps = {}) {
    this.spawn = deps.spawn ?? defaultSpawn;
    this.kill = deps.kill ?? killTree;
    this.now = deps.now ?? Date.now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private prune(): void {
    const cutoff = this.now() - JOB_RETENTION_MS;
    for (const [id, j] of this.jobs)
      if (j.finishedAt !== undefined && j.finishedAt < cutoff) this.jobs.delete(id);
  }

  private snapshot(j: JobState): HarnessJob {
    return { ...j.view, lines: j.dropped + j.lines.length };
  }

  private changed(j: JobState): void {
    this.deps.onChange?.(this.snapshot(j));
  }

  /** The running job for a harness, if any. */
  active(harness: string): HarnessJob | undefined {
    for (const j of this.jobs.values())
      if (j.view.harness === harness && !isJobFinished(j.view)) return this.snapshot(j);
    return undefined;
  }

  start(opts: StartOpts, body: JobBody): HarnessJob {
    this.prune();
    const busy = this.active(opts.harness);
    if (busy)
      throw new BeamhopError(
        'conflict',
        `${opts.harness} is busy with another ${busy.kind}. Wait for it to finish or cancel it.`,
        {
          jobId: busy.id,
        },
      );
    const id = `job_${randomBytes(6).toString('hex')}`;
    const j: JobState = {
      view: {
        id,
        harness: opts.harness,
        ...(opts.displayName ? { displayName: opts.displayName } : {}),
        kind: opts.kind,
        ...(opts.method ? { method: opts.method } : {}),
        step: 'resolving',
        startedAt: this.iso(),
        lines: 0,
      },
      lines: [],
      dropped: 0,
      partial: new Map(),
      secrets: new Set(),
      patterns: [],
      abort: new AbortController(),
      cleanups: [],
      ...(opts.onEnd ? { onEnd: opts.onEnd } : {}),
    };
    this.jobs.set(id, j);
    const what =
      opts.what ??
      (opts.kind === 'login' ? 'The login' : opts.kind === 'update' ? 'The update' : 'The install');
    if (opts.timeoutMs)
      j.timer = setTimeout(() => {
        void this.finish(j, 'failed', 'It took too long and was stopped. Try again.');
      }, opts.timeoutMs);
    j.timer?.unref?.();
    const rt = this.runtime(j);
    void (async () => {
      try {
        const message = await body(rt);
        await this.finish(j, 'done', message);
      } catch (e) {
        if (e instanceof JobCancelled || isJobFinished(j.view)) return;
        const raw = e instanceof Error ? e.message : String(e);
        const message =
          e instanceof JobError
            ? raw
            : (friendlyError(`${raw}\n${rt.text()}`, what) ?? `${what} failed: ${raw}`);
        if (!(e instanceof JobError)) this.addLine(j, `error: ${raw}`);
        await this.finish(j, 'failed', message);
      }
    })();
    this.changed(j);
    return this.snapshot(j);
  }

  private addLine(j: JobState, raw: string): void {
    let line = raw;
    for (const s of j.secrets) if (s) line = line.split(s).join('[redacted]');
    for (const re of j.patterns) line = line.replace(re, '[redacted]');
    j.lines.push(line);
    if (j.lines.length > MAX_JOB_LINES) {
      const over = j.lines.length - MAX_JOB_LINES;
      j.lines.splice(0, over);
      j.dropped += over;
    }
  }

  private feed(
    j: JobState,
    stream: Readable,
    chunk: string,
    onLine?: (l: string) => void,
    flush = false,
  ): void {
    const buf = (j.partial.get(stream) ?? '') + chunk;
    const parts = buf.split(/\r\n|\n|\r/);
    const rest = flush ? '' : (parts.pop() ?? '');
    if (flush && parts.at(-1) === '') parts.pop();
    j.partial.set(stream, rest);
    for (const p of parts) {
      const line = stripAnsi(p).trimEnd();
      if (!line.trim()) continue;
      try {
        onLine?.(line);
      } catch {
        /* a parser bug must not kill the job */
      }
      this.addLine(j, line);
    }
  }

  private runtime(j: JobState): JobRuntime {
    const self = this;
    return {
      id: j.view.id,
      signal: j.abort.signal,
      step(step, message) {
        if (isJobFinished(j.view)) return;
        j.view.step = step;
        if (message !== undefined) j.view.message = message;
        self.changed(j);
      },
      set(fields) {
        if (fields.url !== undefined) j.view.url = fields.url;
        if (fields.code !== undefined) j.view.code = fields.code;
        if (fields.method !== undefined) j.view.method = fields.method;
        self.changed(j);
      },
      line(text) {
        self.addLine(j, stripAnsi(text));
      },
      redact(value) {
        if (!value) return;
        j.secrets.add(value);
        // Lines stored before the secret was known (should not happen: callers redact first).
        j.lines = j.lines.map((l) => l.split(value).join('[redacted]'));
      },
      redactPattern(re) {
        j.patterns.push(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`));
      },
      text() {
        return j.lines.slice(-200).join('\n');
      },
      onCleanup(fn) {
        j.cleanups.unshift(fn);
      },
      stopChild() {
        if (j.child) self.kill(j.child, 'SIGTERM');
      },
      run(cmd, args, opts = {}) {
        if (j.abort.signal.aborted || isJobFinished(j.view)) return Promise.reject(new JobCancelled());
        return new Promise<RunResult>((resolve, reject) => {
          let child: ChildLike;
          try {
            child = self.spawn(cmd, args, {
              env: opts.env ?? process.env,
              ...(opts.cwd ? { cwd: opts.cwd } : {}),
              stdin: opts.stdin ?? 'ignore',
            });
          } catch (e) {
            reject(e);
            return;
          }
          j.child = child;
          if (opts.onStart && child.stdin) {
            const stdin = child.stdin;
            opts.onStart((text) => void stdin.write(text));
          }
          for (const s of [child.stdout, child.stderr]) {
            if (!s) continue;
            s.setEncoding?.('utf8');
            s.on('data', (c: string | Buffer) => self.feed(j, s, String(c), opts.onLine));
          }
          let settled = false;
          child.on('error', (e) => {
            if (settled) return;
            settled = true;
            j.child = undefined;
            reject(
              (e as NodeJS.ErrnoException).code === 'ENOENT'
                ? new JobError(`${cmd} could not be started: it was not found.`)
                : e,
            );
          });
          child.on('exit', (code, signal) => {
            if (settled) return;
            settled = true;
            for (const s of [child.stdout, child.stderr]) if (s) self.feed(j, s, '', opts.onLine, true);
            if (j.child === child) j.child = undefined;
            if (j.abort.signal.aborted) reject(new JobCancelled());
            else resolve({ code, signal });
          });
        });
      },
    };
  }

  private async finish(
    j: JobState,
    step: 'done' | 'failed' | 'cancelled',
    message: string | undefined,
  ): Promise<void> {
    if (isJobFinished(j.view)) return;
    j.view.step = step;
    if (message !== undefined) j.view.message = message;
    else delete j.view.message;
    j.view.endedAt = this.iso();
    j.finishedAt = this.now();
    if (j.timer) clearTimeout(j.timer);
    if (step !== 'done') {
      j.abort.abort();
      const child = j.child;
      if (child) {
        this.kill(child, 'SIGTERM');
        const t = setTimeout(() => this.kill(child, 'SIGKILL'), KILL_GRACE_MS);
        t.unref?.();
        child.on('exit', () => clearTimeout(t));
      }
      for (const fn of j.cleanups.splice(0)) {
        try {
          await fn();
        } catch (e) {
          this.addLine(j, `cleanup failed: ${(e as Error).message}`);
        }
      }
    }
    this.changed(j);
    try {
      j.onEnd?.(this.snapshot(j), [...j.lines]);
    } catch {
      /* audit failures do not change the job */
    }
  }

  private state(jobId: string): JobState {
    this.prune();
    const j = this.jobs.get(jobId);
    if (!j) throw new BeamhopError('not_found', `no job ${jobId} (finished jobs are kept for an hour)`);
    return j;
  }

  get(jobId: string, since = 0): { job: HarnessJob; lines: string[]; next: number } {
    const j = this.state(jobId);
    const total = j.dropped + j.lines.length;
    const from = Math.max(0, Math.min(since, total) - j.dropped);
    return { job: this.snapshot(j), lines: j.lines.slice(from), next: total };
  }

  list(): HarnessJob[] {
    this.prune();
    return [...this.jobs.values()]
      .map((j) => this.snapshot(j))
      .reverse()
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }

  async cancel(jobId: string): Promise<HarnessJob> {
    const j = this.state(jobId);
    await this.finish(j, 'cancelled', 'Cancelled.');
    return this.snapshot(j);
  }

  /** Cancel every running job (daemon shutdown). */
  async shutdown(): Promise<void> {
    for (const j of this.jobs.values())
      if (!isJobFinished(j.view)) await this.finish(j, 'cancelled', 'beamhop stopped.');
  }
}
