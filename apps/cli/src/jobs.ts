/**
 * Following harness jobs (install, update, browser login) from the terminal. The CLI talks plain
 * HTTP, so there are no pushed events: it polls `harness.job.get { jobId, since }`.
 */
import type { BeamhopClient } from '@beamhop/client';
import { type HarnessJob, type HarnessView, isJobFinished } from '@beamhop/core';
import pc from 'picocolors';

export const POLL_MS = 400;

const STEP_LABEL: Record<HarnessJob['step'], string> = {
  resolving: 'Finding the installer…',
  downloading: 'Downloading…',
  verifying: 'Verifying…',
  installing: 'Installing…',
  checking: 'Checking that it works…',
  'waiting-browser': 'Waiting for you to sign in…',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const DONE_WORD: Record<HarnessJob['kind'], string> = {
  install: 'Installed',
  update: 'Updated',
  login: 'Logged in',
};

const KIND_WORD: Record<HarnessJob['kind'], string> = {
  install: 'install',
  update: 'update',
  login: 'login',
};

export const METHOD_LABEL: Record<string, string> = {
  native: "the harness's own installer",
  brew: 'Homebrew',
  npm: 'npm',
  winget: 'winget',
  flow: 'browser sign-in',
};

/**
 * No browser can open on this computer: Linux without a display, any SSH session, or the user said
 * so. The login page is then shown as a URL (and code) to open on another device.
 */
export const isHeadless = (env: Record<string, string | undefined>, platform: string): boolean =>
  Boolean(env.SSH_CONNECTION || env.SSH_TTY) ||
  (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY);

export interface FollowIO {
  out(line: string): void;
  sleep(ms: number): Promise<void>;
  /** Register a Ctrl-C handler while following; returns the unregister function. */
  onInterrupt(fn: () => void): () => void;
}

export interface FollowOptions {
  /** Print every raw output line (dimmed) instead of only the steps. */
  verbose?: boolean;
  /** Print nothing while following (JSON mode). */
  quiet?: boolean;
  /** Display name for messages ("Gemini CLI"); defaults to the harness id. */
  name?: string;
  /** Called once each when a login job first has its URL and its device code. */
  onLogin?(what: 'url' | 'code', value: string): void;
}

export interface FollowResult {
  job: HarnessJob;
  lines: string[];
  /** The user pressed Ctrl-C (we asked the daemon to cancel). */
  interrupted: boolean;
  /** The user pressed Ctrl-C twice: we stopped following; the job may still be running. */
  detached: boolean;
}

/** How many raw lines to show after a failure when they were not shown while following. */
const TAIL = 12;

export const followJob = async (
  c: BeamhopClient,
  start: HarnessJob,
  fio: FollowIO,
  o: FollowOptions = {},
): Promise<FollowResult> => {
  const say = (l: string) => {
    if (!o.quiet) fio.out(l);
  };
  const name = o.name ?? start.harness;
  const lines: string[] = [];
  let job = start;
  let since = 0;
  let lastStep: string | undefined;
  let lastMessage: string | undefined;
  let urlShown = false;
  let codeShown = false;
  let interrupted = false;
  let detached = false;
  let cancelling: Promise<unknown> | undefined;

  const off = fio.onInterrupt(() => {
    if (interrupted) {
      detached = true;
      return;
    }
    interrupted = true;
    say(pc.yellow(`Cancelling the ${name} ${KIND_WORD[job.kind]}… (Ctrl-C again to stop waiting)`));
    cancelling = c.call('harness.job.cancel', { jobId: job.id }).catch((e: unknown) => {
      say(pc.red(`could not cancel: ${(e as Error).message}`));
    });
  });

  const show = (j: HarnessJob) => {
    if (o.onLogin && j.url && !urlShown) {
      urlShown = true;
      o.onLogin('url', j.url);
    }
    if (o.onLogin && j.code && !codeShown) {
      codeShown = true;
      o.onLogin('code', j.code);
    }
    if (isJobFinished(j)) return;
    if (j.step !== lastStep) {
      lastStep = j.step;
      lastMessage = j.message;
      say(`${pc.cyan('→')} ${STEP_LABEL[j.step]}${j.message ? pc.dim(`  ${j.message}`) : ''}`);
    } else if (j.message && j.message !== lastMessage) {
      lastMessage = j.message;
      say(pc.dim(`  ${j.message}`));
    }
  };

  try {
    for (;;) {
      const r = await c.call('harness.job.get', { jobId: job.id, since });
      job = r.job;
      for (const l of r.lines) {
        lines.push(l);
        if (o.verbose) say(pc.dim(`  │ ${l}`));
      }
      since = r.next;
      show(job);
      if (isJobFinished(job) || detached) break;
      await fio.sleep(POLL_MS);
    }
    if (cancelling) await cancelling;
  } finally {
    off();
  }

  if (detached && !isJobFinished(job)) {
    say(pc.dim(`Stopped waiting. Follow it again with: beamhop harness job ${job.id}`));
  } else if (job.step === 'done') {
    say(`${pc.green('✓')} ${DONE_WORD[job.kind]} ${name}${job.message ? pc.dim(`  ${job.message}`) : ''}`);
  } else {
    if (!o.verbose && lines.length && job.step === 'failed') {
      say(pc.dim('  last output:'));
      for (const l of lines.slice(-TAIL)) say(pc.dim(`  │ ${l}`));
    }
    const what = job.step === 'cancelled' ? 'cancelled' : 'failed';
    say(`${pc.red('✗')} ${name} ${KIND_WORD[job.kind]} ${what}${job.message ? `: ${job.message}` : ''}`);
  }
  return { job, lines, interrupted, detached };
};

/** Exit code for a followed job: 0 done, 130 cancelled by our Ctrl-C, 1 otherwise. */
export const jobExitCode = (r: FollowResult): number => {
  if (r.job.step === 'done') return 0;
  if (r.interrupted) return 130;
  return 1;
};

/** "beamhop harness install gemini  (via Homebrew)", or the package-manager text when there is no plan. */
export const installHint = (
  h: Pick<HarnessView, 'id' | 'installPlan' | 'install'>,
  fallback: () => string | undefined,
): string | undefined => {
  const p = h.installPlan;
  if (p && p.method !== 'none') return `beamhop harness install ${h.id}  (via ${p.label})`;
  if (p?.method === 'none')
    return h.install?.url ? `install it by hand: ${h.install.url}` : 'no installer for this computer';
  return fallback();
};
