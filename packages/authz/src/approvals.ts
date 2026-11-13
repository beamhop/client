import type { ApprovalView } from '@beamhop/core';
import { linkedPeople, normalizePrincipal } from './roles.ts';
import { classifyRisk, type Risk, type ToolKindHint } from './tools.ts';

export const UNDO_WINDOW_MS = 30_000;

export interface ApprovalVote {
  by: string;
  allow: boolean;
  at: string;
}

/** An approval with its vote history (stored alongside the ApprovalView fields). */
export type ApprovalState = ApprovalView & { votes: ApprovalVote[] };

export interface ApprovalPolicyOptions {
  /** Principals allowed to decide (owners, plus admins if the caller includes them). */
  approvers: readonly string[];
  /** N of M: how many approvals are needed. Capped at the number of eligible approvers. Default 1. */
  quorum?: number;
  /** Pending approvals expire (→ denied) after this many minutes. Default 15. */
  timeoutMinutes?: number;
  undoWindowMs?: number;
  /**
   * `veto` (default): any eligible deny denies immediately.
   * `quorum`: denied once the remaining approvers can no longer reach the quorum.
   */
  denyMode?: 'veto' | 'quorum';
  /**
   * Linked identities (§5 "Common mapping", `BeamhopConfig.people`). Principals linked to the same
   * person count as one approver: one vote per person, and a requester cannot approve their own
   * request from a second linked account.
   */
  people?: Record<string, string[]>;
  now?: () => number;
}

export type DecideResult =
  | { ok: true; state: ApprovalState; final: boolean }
  | { ok: false; reason: 'not_pending' | 'not_eligible' | 'already_voted' | 'expired'; state: ApprovalState };

export type UndoResult =
  | { ok: true; state: ApprovalState }
  | { ok: false; reason: 'not_decided' | 'window_passed' | 'not_decider' | 'expired' };

export interface CreateApprovalInput {
  id: string;
  agent: string;
  sessionId: string;
  requestedBy: ApprovalView['requestedBy'];
  tool: string;
  title: string;
  input: unknown;
  kind?: ApprovalView['kind'];
  toolKind?: ToolKindHint;
  risk?: Risk;
}

/**
 * Approval policy (§6): first approval wins by default, or N-of-M owners. Pending approvals expire after
 * `approvalTimeoutMinutes` (expired = denied). A decision can be undone within 30 s by whoever made it.
 */
export class ApprovalPolicy {
  readonly approvers: string[];
  readonly quorum: number;
  readonly timeoutMs: number;
  readonly undoWindowMs: number;
  readonly denyMode: 'veto' | 'quorum';
  private readonly now: () => number;
  private readonly people: Record<string, string[]>;
  /** Distinct identities (person or principal) among the approvers. */
  private readonly approverIds: string[];

  constructor(opts: ApprovalPolicyOptions) {
    this.people = opts.people ?? {};
    this.approvers = [...new Set(opts.approvers.map(normalizePrincipal))];
    this.approverIds = [...new Set(this.approvers.map((a) => this.identity(a)))];
    const q = Math.floor(opts.quorum ?? 1);
    this.quorum = Math.max(1, Math.min(Number.isFinite(q) ? q : 1, Math.max(1, this.approverIds.length)));
    this.timeoutMs = Math.max(1, opts.timeoutMinutes ?? 15) * 60_000;
    this.undoWindowMs = opts.undoWindowMs ?? UNDO_WINDOW_MS;
    this.denyMode = opts.denyMode ?? 'veto';
    this.now = opts.now ?? Date.now;
  }

  /** The voting identity of a principal: its linked person, or the principal itself. */
  identity(principal: string): string {
    const persons = linkedPeople(this.people, principal).sort();
    return persons.length ? `person:${persons[0]}` : normalizePrincipal(principal);
  }

  isEligible(principal: string): boolean {
    return this.approvers.includes(normalizePrincipal(principal));
  }

  create(input: CreateApprovalInput): ApprovalState {
    const now = this.now();
    return {
      id: input.id,
      agent: input.agent,
      sessionId: input.sessionId,
      requestedBy: input.requestedBy,
      tool: input.tool,
      title: input.title,
      input: input.input,
      risk: input.risk ?? classifyRisk(input.tool, input.input, input.toolKind),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.timeoutMs).toISOString(),
      status: 'pending',
      kind: input.kind ?? 'tool',
      votes: [],
    };
  }

  /** Expire a pending approval whose deadline passed. Returns the (possibly) updated state. */
  expire(state: ApprovalState): ApprovalState {
    if (state.status !== 'pending' || this.now() < Date.parse(state.expiresAt)) return state;
    return {
      ...state,
      status: 'expired',
      decidedAt: new Date(this.now()).toISOString(),
      decidedBy: 'system:timeout',
    };
  }

  /** Effective approvals needed for this request (the requester's own vote doesn't count when quorum > 1). */
  private needed(state: ApprovalState): { needed: number; pool: number } {
    const requester = this.identity(state.requestedBy.principal);
    const requesterIsApprover = this.approverIds.includes(requester);
    if (this.quorum > 1 && requesterIsApprover) {
      const pool = this.approverIds.length - 1;
      return { needed: Math.max(1, Math.min(this.quorum, pool)), pool: Math.max(1, pool) };
    }
    return { needed: this.quorum, pool: this.approverIds.length };
  }

  decide(state: ApprovalState, by: string, allow: boolean): DecideResult {
    const current = this.expire(state);
    if (current.status === 'expired') return { ok: false, reason: 'expired', state: current };
    if (current.status !== 'pending') return { ok: false, reason: 'not_pending', state: current };
    if (!this.isEligible(by)) return { ok: false, reason: 'not_eligible', state: current };
    const who = this.identity(by);
    if (current.votes.some((v) => this.identity(v.by) === who))
      return { ok: false, reason: 'already_voted', state: current };
    const at = new Date(this.now()).toISOString();
    const votes = [...current.votes, { by, allow, at }];
    const { needed, pool } = this.needed(current);
    const requester = this.identity(current.requestedBy.principal);
    const counts = (v: ApprovalVote) => this.quorum === 1 || this.identity(v.by) !== requester;
    const approvals = votes.filter((v) => v.allow && counts(v));
    const denials = votes.filter((v) => !v.allow);
    let status: ApprovalState['status'] = 'pending';
    if (denials.length > 0 && (this.denyMode === 'veto' || pool - denials.length < needed)) status = 'denied';
    else if (approvals.length >= needed) status = 'approved';
    const next: ApprovalState = { ...current, votes, status };
    if (status !== 'pending') {
      next.decidedAt = at;
      next.decidedBy = (status === 'approved' ? approvals : denials).map((v) => v.by).join(',');
    }
    return { ok: true, state: next, final: status !== 'pending' };
  }

  /** Can the decision still be undone? */
  canUndo(state: ApprovalState): boolean {
    if ((state.status !== 'approved' && state.status !== 'denied') || !state.decidedAt) return false;
    return this.now() - Date.parse(state.decidedAt) < this.undoWindowMs;
  }

  /** When a decision becomes irrevocable (actions may be held until then). */
  settlesAt(state: ApprovalState): number | undefined {
    return state.decidedAt ? Date.parse(state.decidedAt) + this.undoWindowMs : undefined;
  }

  /** Undo a decision within the window; only someone who voted in the final decision may undo it. */
  undo(state: ApprovalState, by: string): UndoResult {
    if (state.status === 'expired') return { ok: false, reason: 'expired' };
    if (state.status !== 'approved' && state.status !== 'denied') return { ok: false, reason: 'not_decided' };
    if (!this.canUndo(state)) return { ok: false, reason: 'window_passed' };
    const who = this.identity(by);
    const deciders = (state.decidedBy ?? '')
      .split(',')
      .filter(Boolean)
      .map((d) => this.identity(d));
    if (!deciders.includes(who)) return { ok: false, reason: 'not_decider' };
    const votes = state.votes.filter((v) => this.identity(v.by) !== who);
    const { decidedAt: _a, decidedBy: _b, ...rest } = state;
    return { ok: true, state: { ...rest, votes, status: 'pending' } };
  }

  /** Strip vote history for the API view. */
  static toView(state: ApprovalState): ApprovalView {
    const { votes: _votes, ...view } = state;
    return view;
  }
}
