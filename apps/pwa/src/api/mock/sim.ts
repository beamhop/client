/**
 * Makes the mock daemon feel alive: agents stream replies and tool calls, approvals arrive and
 * expire, relays flicker, security events trickle in. Also reacts to what the user does
 * (approving apr_a41f lets reviewer push; sending a message gets an answer).
 */
import type { ApprovalView, SessionEventView } from '@beamhop/core';
import type { MockDaemon } from './daemon.ts';
import { RELAYS } from './seed.ts';

type Step = [delayMs: number, run: () => void];

export class Simulator {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private intervals: ReturnType<typeof setInterval>[] = [];
  private approvalTick = 0;
  private auditTick = 0;
  private turnTick = 0;

  constructor(private d: MockDaemon) {
    d.onDecisionReleased = (a) => this.onDecision(a);
    d.onUserMessage = (id, text) => this.reply(id, text);
  }

  /** Start background activity (not used with ?still=1). */
  start() {
    this.later(2500, () => this.ciBotDeployTurn());
    this.every(3000, () => this.d.expireDue());
    this.every(52_000, () => this.newApproval());
    this.every(33_000, () => this.trickleAudit());
    this.every(21_000, () => this.flickerRelays());
    this.every(47_000, () => this.idleTurn());
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    for (const i of this.intervals) clearInterval(i);
    this.timers = [];
    this.intervals = [];
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms));
  }
  private every(ms: number, fn: () => void) {
    this.intervals.push(setInterval(fn, ms));
  }
  private get panicked() {
    return this.d.state.panic.active;
  }

  /** Run steps sequentially; aborts if panic hits mid-script. */
  private script(steps: Step[]) {
    let t = 0;
    for (const [delay, run] of steps) {
      t += delay;
      this.later(t, () => {
        if (!this.panicked) run();
      });
    }
    return t;
  }

  private busy(agent: string, sessionId: string) {
    const a = this.d.state.agents.get(agent);
    if (a && a.status !== 'stopped')
      this.d.putAgent({
        ...a,
        status: 'busy',
        activeSessions: Math.max(1, a.activeSessions),
        lastActivityAt: new Date().toISOString(),
      });
    const s = this.d.state.sessions.get(sessionId);
    if (s) this.d.putSession({ ...s, status: 'running' });
  }
  private idle(agent: string, sessionId: string, ended = false) {
    const a = this.d.state.agents.get(agent);
    if (a && a.status !== 'stopped') {
      const stillRunning = [...this.d.state.sessions.values()].filter(
        (s) => s.agent === agent && s.status === 'running' && s.id !== sessionId,
      ).length;
      this.d.putAgent({ ...a, status: stillRunning ? 'busy' : 'idle', activeSessions: stillRunning });
    }
    const s = this.d.state.sessions.get(sessionId);
    if (s) this.d.putSession({ ...s, status: ended ? 'ended' : 'idle' });
  }
  private spend(agent: string, sessionId: string, usd: number, tok: number) {
    const a = this.d.state.agents.get(agent);
    if (a) {
      const u = a.usageToday;
      this.d.putAgent({
        ...a,
        usageToday: { usd: round(u.usd + usd), tokens: u.tokens + tok, minutes: u.minutes },
      });
      const today = new Date().toISOString().slice(0, 10);
      const row = this.d.state.usage.find((r) => r.day === today && r.agent === agent);
      if (row) {
        row.usd = round(row.usd + usd);
        row.inputTokens += Math.round(tok * 0.94);
        row.outputTokens += Math.round(tok * 0.06);
      }
    }
    const s = this.d.state.sessions.get(sessionId);
    if (s) {
      this.d.putSession({
        ...s,
        usage: {
          inputTokens: s.usage.inputTokens + Math.round(tok * 0.94),
          outputTokens: s.usage.outputTokens + Math.round(tok * 0.06),
          usd: round(s.usage.usd + usd),
        },
      });
    }
  }

  /** Stream `text` into one assistant event, a few words at a time (same seq = replace). */
  private streamSteps(sessionId: string, agent: string, text: string, chunkMs = 140): Step[] {
    const words = text.split(/(\s+)/);
    let seq = 0;
    const steps: Step[] = [];
    let acc = '';
    for (let i = 0; i < words.length; i += 4) {
      const piece = words.slice(i, i + 4).join('');
      steps.push([
        i === 0 ? 400 : chunkMs,
        () => {
          if (i === 0) seq = this.d.nextSeq(sessionId);
          acc += piece;
          this.d.pushEvent(sessionId, { seq, kind: 'assistant', text: acc });
        },
      ]);
    }
    steps.push([
      60,
      () => this.spend(agent, sessionId, 0.01 + text.length / 40_000, Math.round(text.length * 3.2)),
    ]);
    return steps;
  }

  private tool(
    sessionId: string,
    call: NonNullable<SessionEventView['tool']>,
    result: Partial<NonNullable<SessionEventView['tool']>>,
    ms: number,
    progress?: string[],
  ): Step[] {
    const steps: Step[] = [[350, () => this.d.pushEvent(sessionId, { kind: 'tool_call', tool: call })]];
    const per = progress?.length ? ms / (progress.length + 1) : ms;
    for (const p of progress ?? [])
      steps.push([per, () => this.d.pushEvent(sessionId, { kind: 'progress', text: p })]);
    steps.push([
      per,
      () =>
        this.d.pushEvent(sessionId, {
          kind: 'tool_result',
          tool: { id: call.id, name: call.name, ok: true, ...result },
        }),
    ]);
    return steps;
  }

  private ciBotDeployTurn() {
    const sid = 'ses_d17';
    const bob = { principal: 'slack:T01ACME/U02BOB', displayName: 'Bob', role: 'user' };
    this.script([
      [
        0,
        () => {
          this.d.pushEvent(sid, {
            kind: 'user',
            from: bob,
            text: '@ci-bot #211 merged, ship staging please',
          });
          this.busy('ci-bot', sid);
        },
      ],
      ...this.streamSteps(
        sid,
        'ci-bot',
        'On it. #211 is merged at a3f9c1e; building and deploying staging now.',
      ),
      ...this.tool(
        sid,
        {
          id: `fly${Date.now()}`,
          name: 'Bash',
          title: 'Bash fly deploy --app acme-staging',
          input: { command: 'fly deploy --app acme-staging' },
        },
        {
          output:
            '==> Building image\n--> Pushing image done\n✓ Machine 3d8d9e1 [app] update finished: success\nVisit https://acme-staging.fly.dev',
        },
        7000,
        ['building image… 1/3', 'pushing image… 2/3', 'rolling machines… 3/3'],
      ),
      ...this.streamSteps(
        sid,
        'ci-bot',
        'Staging is live: https://acme-staging.fly.dev (release v2026.11.13-1). Health checks pass. Rate limiter from #211 is on with the default 60 req/min.',
      ),
      [300, () => this.idle('ci-bot', sid)],
    ]);
  }

  private idleTurn() {
    if (this.panicked) return;
    this.turnTick++;
    if (this.turnTick % 2 === 1) {
      const sid = 'ses_h31';
      const stranger = this.d.state.events.get(sid)?.[0]?.from;
      this.script([
        [
          0,
          () => {
            this.d.pushEvent(sid, {
              kind: 'user',
              from: stranger,
              text: 'and does the old key stop working right away?',
            });
            this.busy('helpdesk', sid);
          },
        ],
        ...this.streamSteps(
          sid,
          'helpdesk',
          'No. After you rotate, the old key keeps working for 24 hours, then it is revoked. You can revoke it sooner from the same screen with Revoke now.',
        ),
        [300, () => this.idle('helpdesk', sid)],
      ]);
    } else {
      const sid = 'ses_d17';
      this.script([
        [0, () => this.busy('ci-bot', sid)],
        ...this.tool(
          sid,
          {
            id: `hc${Date.now()}`,
            name: 'Fetch',
            title: 'Fetch acme-staging.fly.dev/healthz',
            input: { url: 'https://acme-staging.fly.dev/healthz' },
          },
          { output: '200 OK · 84 ms' },
          1200,
        ),
        ...this.streamSteps(sid, 'ci-bot', 'Hourly check: staging healthy, p95 212 ms.'),
        [300, () => this.idle('ci-bot', sid)],
      ]);
    }
  }

  /** Called when an approval decision leaves its 5 s undo window. */
  private onDecision(a: ApprovalView) {
    if (a.id !== 'apr_a41f' || this.panicked) return;
    const sid = 'ses_842';
    if (a.status === 'approved') {
      this.script([
        [0, () => this.busy('reviewer', sid)],
        ...this.tool(
          sid,
          {
            id: 't5',
            name: 'Bash',
            title: 'Bash git push origin beamhop/842',
            input: { command: 'git push origin beamhop/842' },
          },
          { output: 'To github.com:acme/app.git\n * [new branch]      beamhop/842 -> beamhop/842' },
          1800,
        ),
        ...this.streamSteps(
          sid,
          'reviewer',
          'Pushed `beamhop/842`. CI is running; I opened PR #214 "Keep ?next after login" and linked it in the thread.',
        ),
        [300, () => this.idle('reviewer', sid)],
      ]);
    } else if (a.status === 'denied') {
      this.script([
        ...this.streamSteps(
          sid,
          'reviewer',
          "Okay, I won't push. The fix is committed on `beamhop/842` in my worktree if you want to push it yourself.",
        ),
        [300, () => this.idle('reviewer', sid)],
      ]);
    }
  }

  /** Generic answer to a message sent from the PWA composer. */
  private reply(sessionId: string, text: string) {
    const s = this.d.state.sessions.get(sessionId);
    if (!s) return;
    const agent = s.agent;
    this.script([
      [200, () => this.busy(agent, sessionId)],
      ...this.tool(
        sessionId,
        { id: `r${Date.now()}`, name: 'Read', title: 'Read README.md', input: { path: 'README.md' } },
        { output: '112 lines' },
        600,
      ),
      ...this.streamSteps(
        sessionId,
        agent,
        `Got it: "${text.slice(0, 80)}". This is the demo daemon, so nothing really ran — in a real session ${agent} would work on it here, step by step.`,
      ),
      [300, () => this.idle(agent, sessionId)],
    ]);
  }

  private newApproval() {
    if (this.panicked || this.d.pending().length >= 6) return;
    const n = this.approvalTick++;
    const now = Date.now();
    const templates: Array<Omit<ApprovalView, 'id' | 'createdAt' | 'expiresAt' | 'status' | 'kind'>> = [
      {
        agent: 'ci-bot',
        sessionId: 'ses_d17',
        requestedBy: { principal: 'slack:T01ACME/U02BOB', displayName: 'Bob', role: 'user' },
        tool: 'Fetch',
        title: 'Reach a new host',
        input: {
          host: 'api.github.com',
          url: 'https://api.github.com/repos/acme/app/actions/runs',
          firstTime: true,
          why: 'checking the CI run for #214',
        },
        risk: 'medium',
      },
      {
        agent: 'reviewer',
        sessionId: 'ses_842',
        requestedBy: { principal: 'telegram:5551', displayName: 'Alice', role: 'user' },
        tool: 'Edit',
        title: 'Write a file',
        input: {
          path: '~/code/app/.github/workflows/ci.yml',
          why: 'adding the url tests to CI',
          diff: '+      - run: npm test -- url',
        },
        risk: 'medium',
      },
      {
        agent: 'helpdesk',
        sessionId: 'ses_h31',
        requestedBy: { principal: 'nostr:npub1qz…', displayName: 'npub1qz…8k4', role: 'viewer' },
        tool: 'Read',
        title: 'Read a file',
        input: { path: '~/docs/public/billing.md', why: 'answering a billing question' },
        risk: 'low',
      },
    ];
    const t = templates[n % templates.length]!;
    this.d.putApproval(
      {
        ...t,
        id: `apr_${(now % 0xffff).toString(16).padStart(4, '0')}`,
        kind: 'tool',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 15 * 60_000).toISOString(),
        status: 'pending',
      },
      true,
    );
  }

  private trickleAudit() {
    if (this.panicked) return;
    const i = this.auditTick++;
    const events = [
      {
        agent: 'helpdesk',
        actor: 'srt',
        type: 'sandbox.blocked_host',
        severity: 'security' as const,
        summary: 'helpdesk was blocked from files.pythonhosted.org (learning mode logged it)',
        data: { host: 'files.pythonhosted.org' },
      },
      {
        agent: 'reviewer',
        actor: 'reviewer',
        type: 'session.activity',
        severity: 'info' as const,
        summary: 'reviewer read 3 files in thread 842',
        data: {},
      },
      {
        agent: 'ci-bot',
        actor: 'fly-ams-1',
        type: 'heartbeat',
        severity: 'info' as const,
        summary: 'fly-ams-1 heartbeat · 12 s',
        data: {},
      },
      {
        actor: 'telegram:9911',
        type: 'pairing.failed',
        severity: 'security' as const,
        summary: 'Failed pairing on tg: wrong code from @mallory_x',
        data: { channel: 'tg' },
      },
    ];
    this.d.audit(events[i % events.length]!);
  }

  private flickerRelays() {
    const c = this.d.state.channels.get('nostr');
    if (c?.status !== 'connected') return;
    const up = (c.config.settings.relaysUp as string[] | undefined)?.length ?? 3;
    const next = up >= 4 ? RELAYS.slice(0, 3) : RELAYS;
    this.d.putChannel({ ...c, config: { ...c.config, settings: { ...c.config.settings, relaysUp: next } } });
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
