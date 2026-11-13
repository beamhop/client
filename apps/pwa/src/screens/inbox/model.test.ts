import type { ApprovalView, PolicySuggestion } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import {
  afterRemoval,
  burstAgents,
  filterGroups,
  filterOptions,
  groupApprovals,
  isCredentialFile,
  isLockedPath,
  isMe,
  meNames,
  quorumOf,
  reachOf,
  ruleChoices,
  ruleLine,
  scopeOptions,
  spokenLabel,
  step,
  suggestionChoices,
  swipeMode,
  waitingOnOthers,
  whoDecided,
  wildcardFor,
} from './model.ts';

const NOW = Date.parse('2026-11-13T10:00:00Z');
let n = 0;
const apr = (p: Partial<ApprovalView> & { input?: Record<string, unknown> }): ApprovalView => ({
  id: `apr_${(n++).toString(16).padStart(4, '0')}`,
  agent: 'reviewer',
  sessionId: 'ses_1',
  requestedBy: { principal: 'telegram:1', displayName: 'Alice', role: 'user' },
  tool: 'Bash',
  title: 'Run a shell command',
  input: { command: 'git push origin main' },
  risk: 'low',
  createdAt: new Date(NOW - 60_000).toISOString(),
  expiresAt: new Date(NOW + 12 * 60_000).toISOString(),
  status: 'pending',
  kind: 'tool',
  ...p,
});

describe('reach & swipe mode (risk-scaled)', () => {
  it('classifies the reach from the input', () => {
    expect(reachOf(apr({}))).toBe('command');
    expect(reachOf(apr({ tool: 'Fetch', input: { host: 'pypi.org' } }))).toBe('network');
    expect(reachOf(apr({ tool: 'Read', input: { path: '~/a.md' } }))).toBe('read');
    expect(reachOf(apr({ tool: 'Edit', input: { path: '~/a.md', diff: '+x' } }))).toBe('write');
    expect(reachOf(apr({ kind: 'access-request' }))).toBe('access');
    expect(reachOf(apr({ kind: 'deploy' }))).toBe('deploy');
  });

  it('only LOW tool requests commit on swipe right', () => {
    const one = (a: ApprovalView) => ({ key: a.id, lead: a, items: [a] });
    expect(swipeMode(one(apr({ risk: 'low' })))).toBe('commit');
    expect(swipeMode(one(apr({ risk: 'medium' })))).toBe('intent');
    expect(swipeMode(one(apr({ risk: 'high' })))).toBe('intent');
    expect(swipeMode(one(apr({ risk: 'low', kind: 'access-request' })))).toBe('intent');
    expect(swipeMode(one(apr({ risk: 'low', kind: 'deploy' })))).toBe('intent');
    expect(swipeMode(one(apr({ risk: 'low', quorum: { needed: 2, pool: 2 } })))).toBe('intent');
  });
});

describe('grouping identical requests', () => {
  it('collapses same agent + tool + target, keeps order, never collapses N-of-M', () => {
    const a = apr({ input: { host: 'registry.npmjs.org' }, tool: 'Fetch' });
    const b = apr({ input: { command: 'ls' } });
    const c = apr({ input: { host: 'registry.npmjs.org' }, tool: 'Fetch' });
    const q1 = apr({ kind: 'deploy', input: { command: 'fly deploy' }, quorum: { needed: 2, pool: 2 } });
    const q2 = apr({ kind: 'deploy', input: { command: 'fly deploy' }, quorum: { needed: 2, pool: 2 } });
    const g = groupApprovals([a, b, c, q1, q2]);
    expect(g.map((x) => x.items.length)).toEqual([2, 1, 1, 1]);
    expect(g[0]?.lead.id).toBe(a.id);
  });
});

describe('N-of-M', () => {
  const me = meNames({ principal: 'local:owner', role: 'owner', via: 'local', person: 'alice' });

  it('derives "you" from whoami: principal, display name and linked person', () => {
    expect([...me]).toEqual(['local:owner', 'alice']);
    expect(isMe(me, 'alice')).toBe(true);
    expect(isMe(me, 'bob')).toBe(false);
    expect(isMe(me, undefined)).toBe(false);
    expect(meNames(undefined).size).toBe(0);
    expect(whoDecided(me, 'alice', 'an owner')).toBe('you');
    expect(whoDecided(me, 'bob', 'an owner')).toBe('bob');
    expect(whoDecided(me, undefined, 'an owner')).toBe('an owner');
  });

  it('counts yes votes from the server, seats you, and moves to waiting once you voted', () => {
    const a = apr({
      quorum: { needed: 3, pool: 3 },
      votes: [{ by: 'bob', allow: true, at: '' }],
    });
    const q = quorumOf(a, me);
    expect(q).toMatchObject({ needed: 3, yes: 1, remaining: 2, youVoted: false });
    expect(q?.seats.map((s) => s.name)).toEqual(['bob', 'you', 'another owner']);
    expect(waitingOnOthers(a, me)).toBe(false);
    const voted = { ...a, votes: [...(a.votes ?? []), { by: 'alice', allow: true, at: '' }] };
    // Your vote is recognised from the server's votes alone (no device memory).
    expect(waitingOnOthers(voted, me)).toBe(true);
    expect(quorumOf(voted, me)?.seats).toEqual([
      { name: 'bob', done: true },
      { name: 'you', done: true, you: true },
      { name: 'another owner', done: false, you: false },
    ]);
    expect(quorumOf(voted, me)?.remaining).toBe(1);
    // Someone else's view of the same request: alice is just a name.
    expect(waitingOnOthers(voted, meNames({ principal: 'nostr:npub1x', role: 'owner', via: 'nostr' }))).toBe(
      false,
    );
    // A deny vote doesn't count as waiting.
    expect(waitingOnOthers({ ...a, votes: [{ by: 'alice', allow: false, at: '' }] }, me)).toBe(false);
    expect(quorumOf(apr({}), me)).toBeNull();
  });
});

describe('scope sheet rules', () => {
  it('derives the wildcard only for 3+ label hosts', () => {
    expect(wildcardFor('registry.npmjs.org')).toBe('*.npmjs.org');
    expect(wildcardFor('pypi.org')).toBeNull();
  });

  it('offers host vs domain for network and prints the exact policy line', () => {
    const a = apr({ tool: 'Fetch', input: { host: 'registry.npmjs.org' } });
    const c = ruleChoices(a);
    expect(c.map((x) => x.value)).toEqual(['registry.npmjs.org', '*.npmjs.org']);
    expect(ruleLine(a, '*.npmjs.org')).toBe('+ network.allow: *.npmjs.org');
  });

  it('commands scope to the exact command or its first two words', () => {
    const a = apr({ input: { command: 'git push origin beamhop/842' } });
    expect(ruleChoices(a).map((x) => x.value)).toEqual(['bash:git push origin beamhop/842', 'bash:git push']);
    expect(ruleLine(a, 'bash:git push')).toBe('+ approvals.auto: bash:git push');
  });

  it('paths scope to the file or its folder', () => {
    const a = apr({ tool: 'Read', input: { path: '~/docs/faq/keys.md' } });
    expect(ruleChoices(a).map((x) => x.value)).toEqual(['~/docs/faq/keys.md', '~/docs/faq/']);
    expect(ruleLine(a, '~/docs/faq/')).toBe('+ fs.read: ~/docs/faq/');
  });

  it('never offers a widening the daemon would refuse', () => {
    // Relative paths would be read as host names; ~ itself is never a rule.
    expect(ruleChoices(apr({ tool: 'Read', input: { path: 'src/auth.ts' } }))).toHaveLength(1);
    expect(ruleChoices(apr({ tool: 'Read', input: { path: '~/notes.md' } }))).toHaveLength(1);
    // Interpreters and shell metacharacters only get the exact command.
    expect(ruleChoices(apr({ input: { command: 'bash -c "rm -rf x"' } }))).toHaveLength(1);
    expect(ruleChoices(apr({ input: { command: 'npm test && npm run deploy' } }))).toHaveLength(1);
    // URLs scope by host name (no port).
    const u = apr({ tool: 'Fetch', input: { url: 'https://api.github.com:443/repos' } });
    expect(ruleChoices(u).map((x) => x.value)).toEqual(['api.github.com', '*.github.com']);
  });

  it('never offers session/always for deploys, access requests or N-of-M', () => {
    expect(scopeOptions(apr({}))).toEqual(['once', 'session', 'always']);
    expect(scopeOptions(apr({ kind: 'deploy' }))).toEqual(['once']);
    expect(scopeOptions(apr({ kind: 'access-request' }))).toEqual(['once']);
    expect(scopeOptions(apr({ quorum: { needed: 2, pool: 2 } }))).toEqual(['once']);
  });
});

describe('filters, bursts, navigation, speech', () => {
  const list = [
    apr({ agent: 'ci-bot', risk: 'high' }),
    apr({ agent: 'reviewer', input: { command: 'a' } }),
    apr({ agent: 'reviewer', input: { command: 'b' } }),
  ];
  const groups = groupApprovals(list);

  it('builds chips with counts and filters by agent / high risk', () => {
    expect(filterOptions(groups).map((o) => `${o.label}:${o.count}`)).toEqual([
      'All:3',
      'ci-bot:1',
      'reviewer:2',
      'High risk:1',
    ]);
    expect(filterGroups(groups, 'agent:reviewer')).toHaveLength(2);
    expect(filterGroups(groups, 'high')).toHaveLength(1);
  });

  it('flags bursts above 20 pending from one agent', () => {
    const many = Array.from({ length: 23 }, (_, i) => apr({ agent: 'ci-bot', input: { command: `x${i}` } }));
    expect(burstAgents(many)).toEqual([{ agent: 'ci-bot', count: 23 }]);
    expect(burstAgents(list)).toEqual([]);
  });

  it('j/k clamp at the ends; focus goes to the next item after a decision', () => {
    const keys = ['a', 'b', 'c'];
    expect(step(keys, 'a', -1)).toBe('a');
    expect(step(keys, 'a', 1)).toBe('b');
    expect(step(keys, 'c', 1)).toBe('c');
    expect(step(keys, undefined, 1)).toBe('a');
    expect(afterRemoval(keys, 'b')).toBe('c');
    expect(afterRemoval(keys, 'c')).toBe('b');
    expect(afterRemoval(['a'], 'a')).toBeUndefined();
  });

  it('speaks the whole slip in one sentence', () => {
    const a = apr({ risk: 'high', input: { command: 'git push origin beamhop/842' } });
    expect(spokenLabel({ key: 'k', lead: a, items: [a] }, NOW)).toBe(
      'Approval from reviewer: Run a shell command, git push origin beamhop/842, high risk, auto-denies in 12 minutes',
    );
  });
});

describe('learning-mode guards', () => {
  it('locks secrets folders and spots credential files', () => {
    expect(isLockedPath('~/.ssh/id_ed25519')).toBe(true);
    expect(isLockedPath('~/.aws')).toBe(true);
    expect(isLockedPath('~/.cache/pip')).toBe(false);
    expect(isCredentialFile('~/.npmrc')).toBe(true);
    expect(isCredentialFile('~/app/.env.local')).toBe(true);
    expect(isCredentialFile('~/notes/todo.md')).toBe(false);
  });

  it('offers a wildcard for net suggestions only', () => {
    const s: PolicySuggestion = {
      id: 's',
      agent: 'helpdesk',
      kind: 'net.allow',
      value: 'registry.npmjs.org',
      count: 3,
      lastSeenAt: '',
    };
    expect(suggestionChoices(s).map((c) => c.value)).toEqual(['registry.npmjs.org', '*.npmjs.org']);
    expect(suggestionChoices({ ...s, kind: 'fs.read', value: '~/.cache/pip' })).toHaveLength(1);
  });
});
