import { describe, expect, it } from 'vitest';
import { ApprovalPolicy, type ApprovalState } from '../src/index.ts';

const A = 'nostr:npub1a';
const B = 'nostr:npub1b';
const C = 'nostr:npub1c';
const USER = 'telegram:5';

const setup = (opts: Partial<ConstructorParameters<typeof ApprovalPolicy>[0]> = {}) => {
  let t = Date.parse('2026-11-13T10:00:00Z');
  const policy = new ApprovalPolicy({ approvers: [A, B, C], now: () => t, ...opts });
  const state = policy.create({
    id: 'apr_1',
    agent: 'reviewer',
    sessionId: 'ses_1',
    requestedBy: { principal: USER, role: 'user' },
    tool: 'Bash',
    title: 'Run tests',
    input: { command: 'npm test' },
  });
  return { policy, state, advance: (ms: number) => (t += ms) };
};

const must = (r: ReturnType<ApprovalPolicy['decide']>): ApprovalState => {
  if (!r.ok) throw new Error(r.reason);
  return r.state;
};

describe('ApprovalPolicy', () => {
  it('creates pending approvals with risk and expiry', () => {
    const { state } = setup({ timeoutMinutes: 5 });
    expect(state).toMatchObject({ status: 'pending', risk: 'high', kind: 'tool', votes: [] });
    expect(Date.parse(state.expiresAt) - Date.parse(state.createdAt)).toBe(300_000);
  });

  it('first approval wins by default', () => {
    const { policy, state } = setup();
    const r = policy.decide(state, B, true);
    expect(r).toMatchObject({ ok: true, final: true, state: { status: 'approved', decidedBy: B } });
  });

  it('only eligible approvers may decide (case-insensitive)', () => {
    const { policy, state } = setup();
    expect(policy.decide(state, USER, true)).toMatchObject({ ok: false, reason: 'not_eligible' });
    expect(policy.decide(state, 'NOSTR:NPUB1A', true)).toMatchObject({ ok: true });
  });

  it('N of M quorum', () => {
    const { policy, state } = setup({ quorum: 2 });
    const s1 = must(policy.decide(state, A, true));
    expect(s1.status).toBe('pending');
    expect(policy.decide(s1, 'nostr:NPUB1A', true)).toMatchObject({ ok: false, reason: 'already_voted' });
    const s2 = must(policy.decide(s1, B, true));
    expect(s2.status).toBe('approved');
    expect(s2.decidedBy).toBe(`${A},${B}`);
    expect(policy.decide(s2, C, true)).toMatchObject({ ok: false, reason: 'not_pending' });
  });

  it('quorum is capped at the number of approvers', () => {
    const { policy, state } = setup({ quorum: 10 });
    expect(policy.quorum).toBe(3);
    let s = must(policy.decide(state, A, true));
    s = must(policy.decide(s, B, true));
    expect(s.status).toBe('pending');
    expect(must(policy.decide(s, C, true)).status).toBe('approved');
  });

  it('invalid quorum values fall back to 1', () => {
    expect(setup({ quorum: 0 }).policy.quorum).toBe(1);
    expect(setup({ quorum: Number.NaN }).policy.quorum).toBe(1);
    expect(new ApprovalPolicy({ approvers: [], quorum: 3 }).quorum).toBe(1);
  });

  it('veto: any deny denies', () => {
    const { policy, state } = setup({ quorum: 2 });
    const s1 = must(policy.decide(state, A, true));
    const s2 = must(policy.decide(s1, B, false));
    expect(s2).toMatchObject({ status: 'denied', decidedBy: B });
  });

  it('quorum deny mode: tie keeps it pending until the outcome is decided', () => {
    // 2 of 4: one approve and one deny is a tie, still reachable.
    const D = 'nostr:npub1d';
    const { policy, state } = setup({ approvers: [A, B, C, D], quorum: 2, denyMode: 'quorum' });
    let s = must(policy.decide(state, A, true));
    s = must(policy.decide(s, B, false));
    expect(s.status).toBe('pending');
    s = must(policy.decide(s, C, false));
    // 4 - 2 denials = 2 can still approve → still reachable
    expect(s.status).toBe('pending');
    s = must(policy.decide(s, D, true));
    expect(s.status).toBe('approved');
  });

  it('quorum deny mode: denied once quorum is unreachable', () => {
    const { policy, state } = setup({ quorum: 2, denyMode: 'quorum' });
    let s = must(policy.decide(state, A, false));
    expect(s.status).toBe('pending');
    s = must(policy.decide(s, B, false));
    expect(s.status).toBe('denied');
    expect(s.decidedBy).toBe(`${A},${B}`);
  });

  it("the requester's own vote doesn't count toward a quorum > 1", () => {
    const { policy } = setup({ quorum: 2 });
    const s0 = policy.create({
      id: 'apr_2',
      agent: 'a',
      sessionId: 's',
      requestedBy: { principal: A, role: 'owner' },
      tool: 'Bash',
      title: 't',
      input: {},
    });
    let s = must(policy.decide(s0, A, true));
    s = must(policy.decide(s, B, true));
    expect(s.status).toBe('pending');
    s = must(policy.decide(s, C, true));
    expect(s.status).toBe('approved');
  });

  it('with quorum 1 an owner may approve their own request', () => {
    const { policy } = setup();
    const s0 = policy.create({
      id: 'x',
      agent: 'a',
      sessionId: 's',
      requestedBy: { principal: A, role: 'owner' },
      tool: 'Read',
      title: 't',
      input: {},
    });
    expect(s0.risk).toBe('low');
    expect(must(policy.decide(s0, A, true)).status).toBe('approved');
  });

  it('expires pending approvals (expired = denied)', () => {
    const { policy, state, advance } = setup({ timeoutMinutes: 1 });
    advance(59_999);
    expect(policy.expire(state).status).toBe('pending');
    advance(1);
    expect(policy.expire(state)).toMatchObject({ status: 'expired', decidedBy: 'system:timeout' });
    expect(policy.decide(state, A, true)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('decided approvals do not expire', () => {
    const { policy, state, advance } = setup({ timeoutMinutes: 1 });
    const s = must(policy.decide(state, A, true));
    advance(3_600_000);
    expect(policy.expire(s).status).toBe('approved');
  });

  it('undo within 30s by a decider', () => {
    const { policy, state, advance } = setup();
    const s = must(policy.decide(state, A, true));
    expect(policy.settlesAt(s)).toBe(Date.parse(s.decidedAt!) + 30_000);
    expect(policy.undo(s, B)).toEqual({ ok: false, reason: 'not_decider' });
    advance(29_999);
    const u = policy.undo(s, 'NOSTR:npub1A');
    expect(u).toMatchObject({ ok: true, state: { status: 'pending', votes: [] } });
    if (u.ok) {
      expect(u.state.decidedAt).toBeUndefined();
      // can vote again
      expect(must(policy.decide(u.state, A, false)).status).toBe('denied');
    }
  });

  it('undo fails after the window or when not decided', () => {
    const { policy, state, advance } = setup();
    expect(policy.undo(state, A)).toEqual({ ok: false, reason: 'not_decided' });
    const s = must(policy.decide(state, A, false));
    advance(30_000);
    expect(policy.canUndo(s)).toBe(false);
    expect(policy.undo(s, A)).toEqual({ ok: false, reason: 'window_passed' });
    expect(policy.undo({ ...state, status: 'expired' }, A)).toEqual({ ok: false, reason: 'expired' });
  });

  it('toView strips votes', () => {
    const { state } = setup();
    expect('votes' in ApprovalPolicy.toView(state)).toBe(false);
  });
});
