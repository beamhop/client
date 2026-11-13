/**
 * Fake harness install / update / login jobs for the mock daemon (beamhopd: harness.install, harness.update,
 * harness.loginFlow, harness.job.*). Jobs move through their steps on timers (~2 s for an install) and
 * write believable output lines; when they finish the harness changes like a re-scan would show.
 */
import type { HarnessJob, HarnessJobStep, HarnessView } from '@beamhop/core';

type Update = { id: string; current?: string; latest?: string; available: boolean; required: boolean };

interface Job {
  job: HarnessJob;
  lines: string[];
  timers: ReturnType<typeof setTimeout>[];
}

type Fail = (code: 'not_found' | 'conflict' | 'invalid_input', message: string) => never;

type Script = Array<{ at: number; step: HarnessJobStep; lines?: string[]; patch?: Partial<HarnessJob> }>;

/** Device-code login page the fake login flow "opens". */
export const MOCK_LOGIN_URL = 'https://cursor.com/loginDeepControl?challenge=mock';
export const MOCK_LOGIN_CODE = 'WDJB-MJHT';

export class MockJobs {
  private jobs = new Map<string, Job>();
  private seq = 0;

  constructor(
    private harnesses: () => HarnessView[],
    private updates: Update[],
    private fail: Fail,
  ) {}

  private find(id: string): HarnessView {
    return this.harnesses().find((h) => h.id === id) ?? this.fail('not_found', `No harness ${id}`);
  }

  private busy(id: string) {
    for (const j of this.jobs.values())
      if (j.job.harness === id && !['done', 'failed', 'cancelled'].includes(j.job.step))
        this.fail('conflict', `${this.find(id).displayName} is already being installed or logged in.`);
  }

  private run(
    h: HarnessView,
    kind: HarnessJob['kind'],
    method: HarnessJob['method'],
    script: Script,
    onDone: () => void,
  ) {
    this.busy(h.id);
    this.seq += 1;
    const job: HarnessJob = {
      id: `job_${this.seq}`,
      harness: h.id,
      kind,
      method,
      step: 'resolving',
      startedAt: new Date().toISOString(),
      lines: 0,
    };
    const entry: Job = { job, lines: [], timers: [] };
    this.jobs.set(job.id, entry);
    for (const s of script) {
      entry.timers.push(
        setTimeout(() => {
          entry.lines.push(...(s.lines ?? []));
          entry.job = { ...entry.job, ...s.patch, step: s.step, lines: entry.lines.length };
          if (s.step === 'done') {
            entry.job.endedAt = new Date().toISOString();
            onDone();
          }
        }, s.at),
      );
    }
    return { ...job };
  }

  install(id: string, method?: HarnessJob['method']): HarnessJob {
    const h = this.find(id);
    const plan = h.installPlan;
    if (!plan || plan.method === 'none')
      return this.fail('invalid_input', `beamhop can't install ${h.displayName} on this computer by itself.`);
    const m = (method ?? plan.method) as HarnessJob['method'];
    const cmd = plan.command.join(' ');
    return this.run(
      h,
      'install',
      m,
      [
        {
          at: 250,
          step: 'downloading',
          lines: [`$ ${cmd}`, 'npm http fetch GET 200 https://registry.npmjs.org/ 312ms'],
        },
        { at: 800, step: 'verifying', lines: ['npm verifying integrity sha512-…'] },
        { at: 1200, step: 'installing', lines: ['added 37 packages in 2s'] },
        { at: 1700, step: 'checking', lines: [`$ ${h.command} --version`, '1.0.4'] },
        {
          at: 2100,
          step: 'done',
          patch: { message: `Installed ${h.displayName} 1.0.4 via ${plan.label}` },
        },
      ],
      () => {
        h.version = '1.0.4';
        h.path = `~/.beamhop/harnesses/npm/bin/${h.command}`;
        h.managed = true;
        h.status = h.login && h.login.status === 'logged-out' ? 'needs-login' : 'ready';
      },
    );
  }

  update(id: string): HarnessJob {
    const h = this.find(id);
    if (h.status === 'not-installed') return this.fail('invalid_input', `${h.displayName} is not installed.`);
    const u = this.updates.find((x) => x.id === id);
    const latest = u?.latest ?? h.version ?? '1.0.0';
    return this.run(
      h,
      'update',
      h.managed ? 'npm' : 'brew',
      [
        { at: 250, step: 'downloading', lines: [`Fetching ${h.command} ${latest}`] },
        { at: 900, step: 'installing', lines: [`Upgrading ${h.command} ${h.version ?? ''} -> ${latest}`] },
        { at: 1400, step: 'checking', lines: [`$ ${h.command} --version`, latest] },
        { at: 1800, step: 'done', patch: { message: `Updated ${h.displayName} to ${latest}` } },
      ],
      () => {
        h.version = latest;
        if (h.status === 'unsupported-version') {
          h.status = 'ready';
          delete h.message;
        }
        if (u) {
          u.current = latest;
          u.available = false;
          u.required = false;
        }
      },
    );
  }

  login(id: string, method?: string): HarnessJob {
    const h = this.find(id);
    const signIn = method ? h.login?.methods.find((x) => x.id === method && x.kind === 'home') : undefined;
    if (method && !signIn)
      return this.fail('invalid_input', `${method} is not a sign-in for ${h.displayName}`);
    if (!h.loginFlow && !signIn)
      return this.fail('invalid_input', `${h.displayName} can't be logged in from the app yet.`);
    const device = h.loginFlow?.kind === 'device-code' && !signIn;
    return this.run(
      h,
      'login',
      'flow',
      [
        {
          at: 300,
          step: 'waiting-browser',
          lines: [`Open ${MOCK_LOGIN_URL}`, ...(device ? [`Enter code ${MOCK_LOGIN_CODE}`] : [])],
          patch: { url: MOCK_LOGIN_URL, ...(device ? { code: MOCK_LOGIN_CODE } : {}) },
        },
        { at: 3000, step: 'checking', lines: ['Signed in. Checking…'] },
        { at: 3400, step: 'done', patch: { message: `${h.displayName} is logged in` } },
      ],
      () => {
        h.status = 'ready';
        h.message = 'Logged in';
        if (signIn && h.login) {
          signIn.set = true;
          h.login = {
            ...h.login,
            status: 'logged-in',
            method: signIn.id,
            checkedAt: new Date().toISOString(),
            message: `${signIn.label} sign-in works`,
          };
        }
      },
    );
  }

  get(jobId: string, since: number) {
    const j = this.jobs.get(jobId) ?? this.fail('not_found', `No job ${jobId}`);
    return { job: { ...j.job }, lines: j.lines.slice(since), next: j.lines.length };
  }

  list() {
    return {
      jobs: [...this.jobs.values()]
        .map((j) => ({ ...j.job }))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    };
  }

  cancel(jobId: string): HarnessJob {
    const j = this.jobs.get(jobId) ?? this.fail('not_found', `No job ${jobId}`);
    if (['done', 'failed', 'cancelled'].includes(j.job.step)) return { ...j.job };
    for (const t of j.timers) clearTimeout(t);
    j.lines.push('Cancelled. Cleaned up the partial install.');
    j.job = {
      ...j.job,
      step: 'cancelled',
      message: 'Cancelled. Nothing was changed.',
      endedAt: new Date().toISOString(),
      lines: j.lines.length,
    };
    return { ...j.job };
  }

  close() {
    for (const j of this.jobs.values()) for (const t of j.timers) clearTimeout(t);
  }
}
