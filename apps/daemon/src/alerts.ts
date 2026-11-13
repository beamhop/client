/**
 * Alerts (§9B): turns audit events into Web Push notifications (and owner DMs where the event
 * source does not already send one). Categories: approvals, budget (80/100%), agent crash, cloud
 * agent offline (missed heartbeats) and security-event spikes.
 */
import { type AlertRules, type AuditEvent, DEFAULT_ALERT_RULES } from '@beamhop/core';
import type { Daemon } from './daemon.ts';
import type { PushPayload } from './push.ts';
import { errMsg } from './util.ts';

export interface AlertOptions {
  /** Security events within `spikeWindowMs` that count as a spike (default 5 in 10 minutes). */
  spikeThreshold?: number;
  spikeWindowMs?: number;
  /** At most one crash alert per agent per this many ms (default 10 minutes). */
  crashThrottleMs?: number;
}

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Is `at` (daemon local time) inside the quiet window `start`–`end` (may wrap midnight)? */
export const inQuietHours = (rules: Pick<AlertRules, 'quietStart' | 'quietEnd'>, at: Date): boolean => {
  const now = at.getHours() * 60 + at.getMinutes();
  const a = minutesOf(rules.quietStart);
  const b = minutesOf(rules.quietEnd);
  if (a === b) return false;
  return a < b ? now >= a && now < b : now >= a || now < b;
};

/** Push categories held during quiet hours (approvals and security always come through). */
const QUIET_HELD = new Set(['budget', 'crash', 'offline']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const seg = (v: string) => encodeURIComponent(v);

export class Alerts {
  private readonly security: number[] = [];
  private lastSpike = Number.NEGATIVE_INFINITY;
  private readonly lastCrash = new Map<string, number>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly d: Daemon,
    private readonly opts: AlertOptions = {},
  ) {}

  /** Wait for in-flight deliveries (tests). */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track(p: Promise<unknown>): void {
    const q = p.catch((e) => this.d.log.warn('alert delivery failed', { error: errMsg(e) }));
    this.pending.add(q);
    void q.finally(() => this.pending.delete(q));
  }

  /** Effective alert rules: config `alerts` over daemon options over the defaults. */
  rules(): AlertRules {
    const fromOpts: Partial<AlertRules> = {};
    if (this.opts.spikeThreshold !== undefined) fromOpts.spikeEvents = this.opts.spikeThreshold;
    if (this.opts.spikeWindowMs !== undefined)
      fromOpts.spikeMinutes = Math.max(1, Math.round(this.opts.spikeWindowMs / 60_000));
    return { ...DEFAULT_ALERT_RULES, ...fromOpts, ...defined(this.d.global().alerts ?? {}) };
  }

  /** Spike window in ms (daemon option precision unless config sets minutes). */
  private spikeWindowMs(): number {
    const g = this.d.global().alerts?.spikeMinutes;
    if (g !== undefined) return g * 60_000;
    return this.opts.spikeWindowMs ?? DEFAULT_ALERT_RULES.spikeMinutes * 60_000;
  }

  push(p: PushPayload): void {
    const r = this.rules();
    if (!r.push) return;
    if (r.quietHours && QUIET_HELD.has(p.category) && inQuietHours(r, new Date(this.d.now()))) return;
    this.track(this.d.push.notify(p));
  }

  /** DM owners on their channels, when the `nostrDm` rule is on. */
  dmOwners(markdown: string): void {
    if (!this.rules().nostrDm) return;
    this.track(this.d.notifyOwners(markdown));
  }

  onAudit(ev: AuditEvent): void {
    try {
      this.route(ev);
    } catch (e) {
      this.d.log.warn('alert routing failed', { type: ev.type, error: errMsg(e) });
    }
  }

  private route(ev: AuditEvent): void {
    const agent = ev.agent ?? str(ev.data.agent) ?? 'agent';
    switch (ev.type) {
      case 'approval.requested': {
        const id = str(ev.data.approval);
        const tool = str(ev.data.tool) ?? 'a tool';
        this.push({
          category: 'approvals',
          title: 'Approval needed',
          body: `${agent} wants to run ${tool}${str(ev.data.risk) ? ` (${ev.data.risk} risk)` : ''}`,
          url: id ? `/inbox/${seg(id)}` : '/inbox',
          ...(id ? { approvalId: id, tag: `approval-${id}` } : {}),
        });
        break;
      }
      case 'access.requested': {
        const id = str(ev.data.approval);
        this.push({
          category: 'approvals',
          title: 'Access request',
          body: `Someone new wants to talk to ${agent}`,
          url: id ? `/inbox/${seg(id)}` : '/inbox',
          ...(id ? { approvalId: id, tag: `approval-${id}` } : {}),
        });
        break;
      }
      case 'budget.alert': {
        const pct = typeof ev.data.threshold === 'number' ? Math.round(ev.data.threshold * 100) : undefined;
        this.push({
          category: 'budget',
          title: pct !== undefined && pct >= 100 ? 'Budget exhausted' : 'Budget alert',
          body: `${agent} has used ${pct ?? '?'}% of its daily budget`,
          url: `/agents/${seg(agent)}`,
          tag: `budget-${agent}-${pct ?? 'x'}`,
        });
        break;
      }
      case 'agent.crash': {
        if (!this.rules().crash) break;
        const now = this.d.now();
        const last = this.lastCrash.get(agent) ?? Number.NEGATIVE_INFINITY;
        if (now - last < (this.opts.crashThrottleMs ?? 10 * 60_000)) break;
        this.lastCrash.set(agent, now);
        this.push({
          category: 'crash',
          title: 'Agent crashed',
          body: `${agent} stopped with an error`,
          url: `/agents/${seg(agent)}`,
          tag: `crash-${agent}`,
        });
        this.dmOwners(`💥 *${agent}* crashed. Check the session log in the PWA.`);
        break;
      }
      case 'remote.offline': {
        const dep = str(ev.data.deployment) ?? '';
        this.push({
          category: 'offline',
          title: 'Cloud agent offline',
          body: `${agent}${str(ev.data.provider) ? ` on ${ev.data.provider}` : ''} stopped sending heartbeats`,
          url: dep ? `/deploy/${seg(dep)}` : '/deploy',
          tag: `offline-${dep}`,
        });
        this.dmOwners(`📡 Cloud agent *${agent}* is offline (missed heartbeats).`);
        break;
      }
    }
    if (ev.severity === 'security') this.securityEvent();
  }

  private securityEvent(): void {
    const now = this.d.now();
    const windowMs = this.spikeWindowMs();
    const threshold = this.rules().spikeEvents;
    this.security.push(now);
    while (this.security.length && now - this.security[0]! > windowMs) this.security.shift();
    if (this.security.length < threshold || now - this.lastSpike < windowMs) return;
    this.lastSpike = now;
    const n = this.security.length;
    const minutes = Math.round(windowMs / 60_000);
    // Severity warn: the spike notice itself does not count towards the next spike.
    this.d.audit({
      type: 'security.spike',
      severity: 'warn',
      summary: `${n} security events in the last ${minutes} minutes`,
      actor: 'system:alerts',
      data: { count: n, windowMs },
    });
    this.push({
      category: 'security',
      title: 'Security events spiking',
      body: `${n} security events in the last ${minutes} minutes`,
      url: '/audit',
      tag: 'security-spike',
    });
    this.dmOwners(`🚨 ${n} security events in the last ${minutes} minutes. Review the audit log.`);
  }
}
