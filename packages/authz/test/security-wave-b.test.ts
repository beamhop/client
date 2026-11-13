// Security review wave B: regression and property tests for @beamhop/authz.
import { DEFAULT_ROLES } from '@beamhop/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ApprovalPolicy,
  authorizeCommand,
  BudgetTracker,
  canonicalNostrId,
  canRoute,
  checkMesh,
  constantTimeEqual,
  createPairingCode,
  effectiveRoleDef,
  globMatch,
  hexToNpub,
  normalizePairingCode,
  normalizePrincipal,
  npubToHex,
  PAIRING_ALPHABET,
  parseCommand,
  resolveRoleDetailed,
  verifyPairingCode,
} from '../src/index.ts';

// NIP-19 test vector.
const HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';

const meshCfg = (block: string[]) => ({
  allow: [] as string[],
  block,
  maxHops: 3,
  maxTurnsPerThread: 6,
  perPeerBudget: {},
  acceptJobs: [] as number[],
});

const membership = (target: string, defaultRole = 'user') => ({
  target,
  defaultRole,
  triggers: ['mention', 'reply'] as ('mention' | 'reply')[],
});

describe('AUTHZ-1: Nostr principal aliasing (hex vs npub)', () => {
  it('bech32 codec round-trips the NIP-19 vector and rejects bad checksums', () => {
    expect(hexToNpub(HEX)).toBe(NPUB);
    expect(npubToHex(NPUB)).toBe(HEX);
    expect(npubToHex(NPUB.toUpperCase())).toBe(HEX);
    expect(npubToHex(`${NPUB.slice(0, -1)}q`)).toBeUndefined();
    expect(canonicalNostrId(`nostr:${NPUB}`)).toBe(NPUB);
    expect(canonicalNostrId(HEX.toUpperCase())).toBe(NPUB);
    expect(canonicalNostrId('npub1notakey')).toBeUndefined();
  });

  it('normalizes every Nostr form of a key to the same principal', () => {
    const forms = [`nostr:${NPUB}`, `nostr:${HEX}`, `NOSTR:${HEX.toUpperCase()}`, `nostr:nostr:${NPUB}`];
    for (const f of forms) expect(normalizePrincipal(f)).toBe(`nostr:${NPUB}`);
  });

  it('a mesh block entry written as hex blocks the npub principal the channel emits', () => {
    const r = resolveRoleDetailed({
      principal: `nostr:${NPUB}`,
      agent: {
        grants: {},
        public: false,
        mesh: meshCfg([HEX]),
      },
      global: { owners: [], grants: {}, people: {} },
      membership: membership('nostr:group/relay.example/abc'),
      isAgent: true,
    });
    expect(r).toEqual({ role: null, reason: 'blocked' });
  });

  it('a block entry as a hex principal also blocks', () => {
    const r = resolveRoleDetailed({
      principal: `nostr:${NPUB}`,
      agent: {
        grants: {},
        public: false,
        mesh: meshCfg([`nostr:${HEX}`]),
      },
      global: { owners: [], grants: {}, people: {} },
      membership: membership('nostr:group/relay.example/abc'),
    });
    expect(r.role).toBeNull();
  });

  it('owners and grants keyed by hex apply to the npub principal', () => {
    const base = {
      agent: { grants: {}, public: false, mesh: meshCfg([]) },
      membership: membership('nostr:dm'),
    };
    expect(
      resolveRoleDetailed({
        ...base,
        principal: `nostr:${NPUB}`,
        global: { owners: [`nostr:${HEX}`], grants: {}, people: {} },
      }).role,
    ).toBe('owner');
    expect(
      resolveRoleDetailed({
        ...base,
        principal: `nostr:${NPUB}`,
        global: { owners: [], grants: { [`nostr:${HEX}`]: 'admin' }, people: {} },
      }).role,
    ).toBe('admin');
  });

  it('a bare npub block entry does not match a non-Nostr principal', () => {
    const r = resolveRoleDetailed({
      principal: `telegram:${NPUB}`,
      agent: {
        grants: {},
        public: false,
        mesh: meshCfg([NPUB]),
      },
      global: { owners: [], grants: {}, people: {} },
      membership: membership('tg:group/-1'),
    });
    expect(r.role).toBe('user');
  });

  it('property: principals of different keys never collide; same key always does', () => {
    const hex = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => Buffer.from(b).toString('hex'));
    fc.assert(
      fc.property(hex, hex, (a, b) => {
        const na = normalizePrincipal(`nostr:${a}`);
        expect(na).toBe(normalizePrincipal(`nostr:${hexToNpub(a)}`));
        expect(npubToHex(na.slice('nostr:'.length))).toBe(a);
        if (a !== b) expect(na).not.toBe(normalizePrincipal(`nostr:${b}`));
      }),
    );
  });
});

describe('AUTHZ-2: approval quorum with linked identities', () => {
  const people = { alice: ['nostr:alice-key', 'telegram:111'], bob: ['nostr:bob-key'] };
  const approvers = ['nostr:alice-key', 'telegram:111', 'nostr:bob-key'];
  const mk = (requester: string) => {
    const policy = new ApprovalPolicy({ approvers, quorum: 2, people, now: () => 1_000 });
    const state = policy.create({
      id: 'apr_1',
      agent: 'a',
      sessionId: 's',
      requestedBy: { principal: requester, displayName: 'r', role: 'user' },
      tool: 'Bash',
      title: 't',
      input: {},
    });
    return { policy, state };
  };

  it('one person cannot satisfy a 2-of-M quorum by voting from two linked accounts', () => {
    const { policy, state } = mk('telegram:999');
    const first = policy.decide(state, 'nostr:alice-key', true);
    expect(first.ok && first.state.status).toBe('pending');
    if (!first.ok) throw new Error('unexpected');
    const second = policy.decide(first.state, 'telegram:111', true);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.reason).toBe('already_voted');
    const bob = policy.decide(first.state, 'nostr:bob-key', true);
    expect(bob.ok && bob.state.status).toBe('approved');
  });

  it('the requester cannot approve their own request from a second linked account', () => {
    const four = [...approvers, 'nostr:carol-key'];
    const policy = new ApprovalPolicy({ approvers: four, quorum: 2, people, now: () => 1_000 });
    let state = policy.create({
      id: 'apr_2',
      agent: 'a',
      sessionId: 's',
      requestedBy: { principal: 'nostr:alice-key', role: 'owner' },
      tool: 'Bash',
      title: 't',
      input: {},
    });
    for (const [by, want] of [
      ['telegram:111', 'pending'],
      ['nostr:bob-key', 'pending'],
      ['nostr:carol-key', 'approved'],
    ] as const) {
      const r = policy.decide(state, by, true);
      if (!r.ok) throw new Error(r.reason);
      expect(r.state.status).toBe(want);
      state = r.state;
    }
  });

  it('quorum is capped by distinct people, not principals', () => {
    const policy = new ApprovalPolicy({ approvers, quorum: 3, people });
    expect(policy.quorum).toBe(2);
  });

  it('property: no single identity ever reaches status approved when quorum > 1', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('nostr:alice-key', 'telegram:111', 'NOSTR:ALICE-KEY'), { maxLength: 6 }),
        (voters) => {
          const { policy } = mk('telegram:999');
          let { state } = mk('telegram:999');
          for (const v of voters) {
            const r = policy.decide(state, v, true);
            if (r.ok) state = r.state;
          }
          expect(state.status).toBe('pending');
        },
      ),
    );
  });
});

describe('AUTHZ-3: budgets fail closed on corrupt usage', () => {
  it('a NaN spend does not disable the daily dollar cap', () => {
    const t = new BudgetTracker({ now: () => Date.parse('2026-11-13T10:00:00Z') });
    t.record('agent:a', { usd: Number.NaN });
    expect(t.checkDaily('agent:a', { dailyUsd: 5 }).ok).toBe(false);
    t.load('agent:b', { tokens: Number.NaN, usd: 0, minutes: 0 });
    expect(t.checkDaily('agent:b', { dailyTokens: 100 }).ok).toBe(false);
  });

  it('a NaN session start does not disable the minute cap', () => {
    const t = new BudgetTracker();
    expect(t.checkSession(Number.NaN, { perSessionMinutes: 30 }).ok).toBe(false);
  });

  it('negative spend cannot refund the budget', () => {
    const t = new BudgetTracker();
    t.record('k', { usd: 5 });
    t.record('k', { usd: -100 });
    expect(t.checkDaily('k', { dailyUsd: 5 }).ok).toBe(false);
  });
});

describe('AUTHZ-4: glob matcher is linear (no ReDoS)', () => {
  it('handles many-star patterns against long agent-chosen values quickly', () => {
    const value = 'a'.repeat(50_000);
    const t0 = performance.now();
    expect(globMatch('*a*a*a*a*a*a*a*b', value)).toBe(false);
    expect(canRoute('x:channel/1', `x:channel/${value}`, [{ from: '*', to: '*:*a*a*a*a*a*b' }])).toBe(false);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it('keeps glob semantics', () => {
    expect(globMatch('mcp__*__create_*', 'mcp__github__create_pr')).toBe(true);
    expect(globMatch('Bash', 'bash')).toBe(true);
    expect(globMatch('Bash', 'bash', { caseInsensitive: false })).toBe(false);
    expect(globMatch('a?c', 'abc')).toBe(true);
    expect(globMatch('a?c', 'ac')).toBe(false);
    expect(globMatch('a.c', 'abc')).toBe(false);
    expect(globMatch('*', '')).toBe(true);
    expect(globMatch('(x)+[y]', '(x)+[y]')).toBe(true);
    expect(globMatch('?', '😀')).toBe(true);
  });

  it('property: agrees with a reference regex on small inputs', () => {
    const ch = fc.constantFrom('a', 'b', '*', '?', '.', '\\');
    fc.assert(
      fc.property(
        fc.array(ch, { maxLength: 8 }),
        fc.array(fc.constantFrom('a', 'b', '.', '*'), { maxLength: 10 }),
        (p, v) => {
          const pat = p.join('');
          const src = [...pat]
            .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
            .join('');
          expect(globMatch(pat, v.join(''), { caseInsensitive: false })).toBe(
            new RegExp(`^${src}$`, 'su').test(v.join('')),
          );
        },
      ),
    );
  });
});

describe('parseCommand / authorizeCommand properties', () => {
  const viewer = effectiveRoleDef('viewer')!;
  const user = effectiveRoleDef('user')!;
  const agent = effectiveRoleDef('agent')!;

  it('never throws, and commands parsed from arbitrary text never let non-approvers approve', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (text) => {
        const p = parseCommand(text);
        if (!p?.ok) return;
        for (const role of [viewer, user, agent]) {
          const a = authorizeCommand(role, p.command);
          if (p.command.name === 'approve' || p.command.name === 'deny') expect(a.allowed).toBe(false);
          if (p.command.name === 'mode' && p.command.mode === 'auto' && role.permissionMode !== 'auto')
            expect(a.allowed).toBe(false);
        }
        // Unknown senders may only /pair.
        expect(authorizeCommand(null, p.command).allowed).toBe(p.command.name === 'pair');
      }),
    );
  });

  it('tricks: fullwidth slash and invisible prefixes are not commands; case folding is', () => {
    expect(parseCommand('／approve 1')).toBeNull();
    expect(parseCommand('‏/approve 1')).toBeNull();
    expect(parseCommand('​/approve 1')).toBeNull();
    const up = parseCommand('/APPROVE apr_1');
    expect(up?.ok && up.command.name).toBe('approve');
    const other = parseCommand('/approve@otherbot apr_1');
    expect(other?.addressedTo).toBe('otherbot');
  });

  it('is linear on long adversarial input', () => {
    const t0 = performance.now();
    parseCommand(`/${'a'.repeat(100_000)}@${'b'.repeat(100_000)}`);
    parseCommand(`/approve ${' x'.repeat(100_000)}`);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe('mesh hop tag properties', () => {
  it('any hop value from a peer (negative, NaN, huge, fractional) never resets or bypasses caps', () => {
    fc.assert(
      fc.property(fc.oneof(fc.double(), fc.integer()), (hops) => {
        const r = checkMesh({
          thread: { turns: 0, hops: 0, humanRequired: false },
          hops,
          config: { maxHops: 3, maxTurnsPerThread: 6 },
          fromHuman: false,
        });
        if (r.action === 'allow') {
          expect(r.outgoingHops).toBeGreaterThanOrEqual(1);
          expect(r.outgoingHops).toBeLessThanOrEqual(3);
          expect(r.next.turns).toBe(1);
        } else expect(r.next.humanRequired).toBe(true);
      }),
    );
  });
});

describe('pairing code properties', () => {
  it('verify never throws and only the exact code (modulo case/separators) verifies', () => {
    const code = createPairingCode({ now: 0 });
    const record = { code: code.code, expiresAt: code.expiresAt };
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (input) => {
        const r = verifyPairingCode(input, record, { now: 1 });
        if (r.ok) expect(normalizePairingCode(input)).toBe(code.code);
      }),
    );
    expect(verifyPairingCode(code.code.toLowerCase().split('').join('-'), record, { now: 1 }).ok).toBe(true);
    expect(verifyPairingCode(code.code, { ...record, attempts: 5 }, { now: 1 }).ok).toBe(false);
    expect([...code.code].every((c) => PAIRING_ALPHABET.includes(c))).toBe(true);
    expect(constantTimeEqual('a', 'ab')).toBe(false);
  });
});

it('default roles keep their safety invariants', () => {
  expect(DEFAULT_ROLES.find((r) => r.name === 'agent')?.canApprove).toBe(false);
});
