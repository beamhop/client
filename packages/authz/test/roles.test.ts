import { AgentConfig, BeamhopConfig, DEFAULT_ROLES, type Membership } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import {
  allRoleDefs,
  effectiveRoleDef,
  linkedPeople,
  normalizePrincipal,
  resolveRole,
  resolveRoleDetailed,
  samePrincipal,
} from '../src/index.ts';

const OWNER = 'nostr:npub1owner';
const agent = (over: Record<string, unknown> = {}) => AgentConfig.parse({ name: 'a', harness: 'claude', ...over });
const global = (over: Record<string, unknown> = {}) => BeamhopConfig.parse({ owners: [OWNER], ...over });
const dm: Membership = { target: 'nostr:dm', defaultRole: 'user', triggers: ['dm'] };
const group: Membership = { target: 'tg:group/-100', defaultRole: 'user', triggers: ['mention', 'reply'] };

describe('normalizePrincipal', () => {
  it('lower-cases provider and ids of case-insensitive providers', () => {
    expect(normalizePrincipal(' NOSTR:NPUB1ABC ')).toBe('nostr:npub1abc');
    expect(normalizePrincipal('Slack:T01/U02')).toBe('slack:t01/u02');
    expect(normalizePrincipal('myplug:CaseSensitive')).toBe('myplug:CaseSensitive');
  });
  it('NFC-normalizes unicode', () => {
    expect(samePrincipal('myplug:café', 'myplug:café')).toBe(true);
  });
  it('handles strings without provider', () => {
    expect(normalizePrincipal('ABC')).toBe('abc');
  });
});

describe('resolveRole', () => {
  it('owners are owners, regardless of case and membership', () => {
    expect(resolveRole({ principal: 'NOSTR:NPUB1OWNER', agent: agent(), global: global() })).toBe('owner');
    expect(resolveRole({ principal: OWNER, agent: agent(), global: global(), membership: dm })).toBe('owner');
  });

  it('owner beats a block list entry', () => {
    const a = agent({ mesh: { block: ['npub1owner'] } });
    expect(resolveRole({ principal: OWNER, agent: a, global: global() })).toBe('owner');
  });

  it('agent grants beat global grants', () => {
    const p = 'telegram:5551';
    const a = agent({ grants: { [p]: 'admin' } });
    const g = global({ grants: { [p]: 'viewer' } });
    expect(resolveRoleDetailed({ principal: p, agent: a, global: g, membership: dm })).toEqual({
      role: 'admin',
      source: 'agent-grant',
    });
    expect(resolveRoleDetailed({ principal: p, agent: agent(), global: g, membership: dm })).toEqual({
      role: 'viewer',
      source: 'global-grant',
    });
  });

  it('grant keys are matched case-insensitively', () => {
    const a = agent({ grants: { 'Telegram:5551': 'admin' } });
    expect(resolveRole({ principal: 'telegram:5551', agent: a, global: global() })).toBe('admin');
  });

  it('linked identities inherit grants of linked principals or the person id', () => {
    const g = global({
      people: { alice: ['telegram:1', 'nostr:npub1alice'] },
      grants: { 'nostr:npub1alice': 'admin' },
    });
    expect(resolveRoleDetailed({ principal: 'telegram:1', agent: agent(), global: g, membership: dm })).toEqual({
      role: 'admin',
      source: 'person-grant',
      person: 'alice',
    });
    const g2 = global({ people: { alice: ['telegram:1'] } });
    const a2 = agent({ grants: { alice: 'user' } });
    expect(resolveRole({ principal: 'telegram:1', agent: a2, global: g2, membership: dm })).toBe('user');
  });

  it('a principal linked to an owner is the owner', () => {
    const g = global({ people: { me: [OWNER, 'telegram:42'] } });
    expect(resolveRoleDetailed({ principal: 'telegram:42', agent: agent(), global: g })).toEqual({
      role: 'owner',
      source: 'owner',
      person: 'me',
    });
    expect(linkedPeople(g.people, 'TELEGRAM:42')).toEqual(['me']);
  });

  it('group members get the membership default role', () => {
    expect(resolveRole({ principal: 'telegram:9', agent: agent(), global: global(), membership: group })).toBe(
      'user',
    );
  });

  it('unknown DM senders are ignored unless the agent is public', () => {
    expect(resolveRoleDetailed({ principal: 'nostr:npub1x', agent: agent(), global: global(), membership: dm })).toEqual(
      { role: null, reason: 'unknown-sender' },
    );
    expect(
      resolveRole({ principal: 'nostr:npub1x', agent: agent({ public: true }), global: global(), membership: dm }),
    ).toBe('viewer');
  });

  it('without a membership only identity-based roles apply', () => {
    expect(resolveRoleDetailed({ principal: 'nostr:npub1x', agent: agent(), global: global() })).toEqual({
      role: null,
      reason: 'no-membership',
    });
  });

  it('revoked memberships resolve to nothing for non-owners, even with grants', () => {
    const m = { ...group, revokedAt: '2026-01-01T00:00:00Z' };
    const a = agent({ grants: { 'telegram:9': 'admin' } });
    expect(resolveRoleDetailed({ principal: 'telegram:9', agent: a, global: global(), membership: m })).toEqual({
      role: null,
      reason: 'revoked-membership',
    });
  });

  it('peer agents default to the agent role', () => {
    expect(
      resolveRoleDetailed({ principal: 'nostr:npub1peer', agent: agent(), global: global(), membership: dm, isAgent: true }),
    ).toEqual({ role: 'agent', source: 'peer' });
  });

  it('blocked peers are dropped; block entries can be bare npubs or principals', () => {
    for (const entry of ['npub1peer', 'NOSTR:npub1PEER']) {
      const a = agent({ mesh: { block: [entry] } });
      expect(
        resolveRoleDetailed({ principal: 'nostr:npub1peer', agent: a, global: global(), membership: dm, isAgent: true }),
      ).toEqual({ role: null, reason: 'blocked' });
    }
  });

  it('block beats an explicit grant', () => {
    const a = agent({ mesh: { block: ['npub1peer'] }, grants: { 'nostr:npub1peer': 'admin' } });
    expect(resolveRole({ principal: 'nostr:npub1peer', agent: a, global: global(), isAgent: true })).toBeNull();
  });

  it('allowed peers get the membership default; without membership the agent role', () => {
    const a = agent({ mesh: { allow: ['npub1peer'] } });
    expect(
      resolveRoleDetailed({ principal: 'nostr:npub1peer', agent: a, global: global(), membership: group, isAgent: true }),
    ).toEqual({ role: 'user', source: 'peer-allowed' });
    expect(resolveRole({ principal: 'nostr:npub1peer', agent: a, global: global(), isAgent: true })).toBe('agent');
  });

  it('explicit grants apply to peers too', () => {
    const a = agent({ grants: { 'nostr:npub1peer': 'viewer' } });
    expect(resolveRole({ principal: 'nostr:npub1peer', agent: a, global: global(), isAgent: true })).toBe('viewer');
  });

  it('does not treat substrings or prefixes as matches', () => {
    const g = global({ owners: ['nostr:npub1own'] });
    expect(resolveRole({ principal: 'nostr:npub1owner', agent: agent(), global: g })).toBeNull();
  });
});

describe('effectiveRoleDef', () => {
  it('returns built-ins unchanged without overrides', () => {
    for (const r of DEFAULT_ROLES) expect(effectiveRoleDef(r.name)).toEqual(r);
  });

  it('returns null for unknown roles', () => {
    expect(effectiveRoleDef('nope')).toBeNull();
  });

  it('merges overrides field by field', () => {
    const r = effectiveRoleDef('user', [{ name: 'user', budget: { messagesPerMinute: 2 }, tools: { deny: ['web*'] } }])!;
    expect(r.budget).toEqual({ messagesPerMinute: 2, perSessionMinutes: 20 });
    expect(r.tools).toEqual({ allow: [], deny: ['web*'] });
    expect(r.permissionMode).toBe('ask');
  });

  it('ignores undefined fields in overrides', () => {
    const r = effectiveRoleDef('viewer', [{ name: 'viewer', permissionMode: undefined }])!;
    expect(r.permissionMode).toBe('read-only');
  });

  it('new custom roles start from viewer defaults', () => {
    const r = effectiveRoleDef('reviewer', [{ name: 'reviewer', commands: ['help'] }])!;
    expect(r.permissionMode).toBe('read-only');
    expect(r.canApprove).toBe(false);
    expect(r.commands).toEqual(['help']);
    expect(r.description).toBe('');
  });

  it('enforces invariants for owner and agent', () => {
    expect(effectiveRoleDef('owner', [{ name: 'owner', canApprove: false, canPrompt: false }])!.canApprove).toBe(true);
    const ag = effectiveRoleDef('agent', [{ name: 'agent', canApprove: true, canReconfigure: true }])!;
    expect(ag.canApprove).toBe(false);
    expect(ag.canReconfigure).toBe(false);
  });

  it('allRoleDefs lists built-ins and customs once', () => {
    const names = allRoleDefs([{ name: 'user' }, { name: 'ops' }]).map((r) => r.name);
    expect(names).toEqual(['owner', 'admin', 'user', 'viewer', 'agent', 'ops']);
  });
});
