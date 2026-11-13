import { DEFAULT_ROLES, type Membership, type RoleDef } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import { authorizeCommand, type Command, helpText, isAddressedTo, parseCommand, shouldTrigger } from '../src/index.ts';

const role = (name: string): RoleDef => DEFAULT_ROLES.find((r) => r.name === name)!;
const cmd = (text: string): Command => {
  const p = parseCommand(text);
  if (!p?.ok) throw new Error(`not ok: ${text}`);
  return p.command;
};

describe('parseCommand', () => {
  it('returns null for non-commands', () => {
    for (const t of ['hello', '', ' ', 'use /new to restart', '/usr/bin/env', '/', '//new', '/123', '/new@'])
      expect(parseCommand(t)).toBeNull();
  });
  it.each(['new', 'stop', 'status', 'resume', 'details', 'usage', 'help'])('parses /%s', (n) => {
    expect(parseCommand(`/${n}`)).toEqual({ ok: true, command: { name: n, args: [] } });
  });
  it('is case-insensitive and trims', () => {
    expect(parseCommand('  /NeW  ')).toEqual({ ok: true, command: { name: 'new', args: [] } });
  });
  it('supports Telegram /cmd@botname', () => {
    expect(parseCommand('/status@MyBot')).toEqual({ ok: true, command: { name: 'status', args: [] }, addressedTo: 'MyBot' });
    expect(parseCommand('/approve@my_bot abc123')).toMatchObject({ ok: true, command: { id: 'abc123' } });
  });
  it('supports unicode bot names', () => {
    expect(parseCommand('/help@Bötchen')).toMatchObject({ ok: true, addressedTo: 'Bötchen' });
  });
  it('approve/deny require an id', () => {
    expect(cmd('/approve apr_1')).toEqual({ name: 'approve', id: 'apr_1', args: ['apr_1'] });
    expect(cmd('/deny   apr_2  extra')).toMatchObject({ name: 'deny', id: 'apr_2' });
    expect(parseCommand('/approve')).toMatchObject({ ok: false, known: true, error: 'usage: /approve <id>' });
  });
  it('model and harness take optional arguments', () => {
    expect(cmd('/model')).toEqual({ name: 'model', args: [] });
    expect(cmd('/model openai/gpt-5')).toMatchObject({ model: 'openai/gpt-5' });
    expect(cmd('/harness codex')).toMatchObject({ harness: 'codex' });
  });
  it('mode validates its argument', () => {
    expect(cmd('/mode plan')).toMatchObject({ mode: 'plan' });
    expect(cmd('/mode AUTO')).toMatchObject({ mode: 'auto' });
    expect(cmd('/mode read-only')).toMatchObject({ mode: 'read-only' });
    expect(cmd('/mode readonly')).toMatchObject({ mode: 'read-only' });
    expect(cmd('/mode')).toEqual({ name: 'mode', args: [] });
    expect(parseCommand('/mode yolo')).toMatchObject({ ok: false });
  });
  it('pair joins spaced codes', () => {
    expect(cmd('/pair ABC 123')).toMatchObject({ name: 'pair', code: 'ABC123' });
    expect(parseCommand('/pair')).toMatchObject({ ok: false });
  });
  it('reports unknown commands', () => {
    expect(parseCommand('/frob x')).toEqual({ ok: false, name: 'frob', error: 'unknown command /frob', known: false });
  });
  it('handles multi-line args', () => {
    expect(cmd('/model\nfoo')).toMatchObject({ model: 'foo' });
  });
});

describe('isAddressedTo', () => {
  it('matches case-insensitively and ignores leading @', () => {
    expect(isAddressedTo({ addressedTo: 'MyBot' }, ['@mybot'])).toBe(true);
    expect(isAddressedTo({ addressedTo: 'other' }, ['mybot'])).toBe(false);
    expect(isAddressedTo({}, [])).toBe(true);
  });
});

describe('authorizeCommand', () => {
  it('unknown senders may only pair', () => {
    expect(authorizeCommand(null, cmd('/pair ABCDEF'))).toEqual({ allowed: true });
    expect(authorizeCommand(null, cmd('/help'))).toMatchObject({ allowed: false });
  });
  it('respects the role command list', () => {
    expect(authorizeCommand(role('viewer'), cmd('/new'))).toEqual({ allowed: true });
    expect(authorizeCommand(role('viewer'), cmd('/stop'))).toMatchObject({ allowed: false });
    expect(authorizeCommand(role('agent'), cmd('/new'))).toMatchObject({ allowed: false });
  });
  it('approvals need canApprove even if listed', () => {
    const r = { ...role('user'), commands: [...role('user').commands, 'approve'] };
    expect(authorizeCommand(r, cmd('/approve x'))).toMatchObject({ allowed: false, reason: expect.stringMatching(/approve/) });
    expect(authorizeCommand(role('admin'), cmd('/approve x'))).toEqual({ allowed: true });
  });
  it('reconfiguring needs canReconfigure; showing does not', () => {
    const r = { ...role('user'), commands: [...role('user').commands, 'model'] };
    expect(authorizeCommand(r, cmd('/model'))).toEqual({ allowed: true });
    expect(authorizeCommand(r, cmd('/model x'))).toMatchObject({ allowed: false });
  });
  it('/mode cannot loosen beyond the role mode (owners excepted)', () => {
    expect(authorizeCommand(role('admin'), cmd('/mode auto'))).toMatchObject({ allowed: false });
    expect(authorizeCommand(role('admin'), cmd('/mode plan'))).toEqual({ allowed: true });
    expect(authorizeCommand(role('owner'), cmd('/mode auto'))).toEqual({ allowed: true });
  });
  it('help lists only allowed commands', () => {
    expect(helpText(role('agent'))).toBe('/status — Show session and agent status\n/help — List commands');
    expect(helpText(null)).toMatch(/^\/pair/);
  });
});

describe('shouldTrigger', () => {
  const dmMembership: Membership = { target: 'x:dm', defaultRole: 'viewer', triggers: ['dm'] };
  const groupMembership: Membership = { target: 'x:group/1', defaultRole: 'user', triggers: ['mention', 'reply'] };
  const base = { text: 'hi', mentionsAgent: false, replyToAgent: false, attachments: [] };
  const dm = { ...base, conversation: { kind: 'dm' as const, id: '1' } };
  const grp = { ...base, conversation: { kind: 'group' as const, id: '1' } };
  const user = role('user');

  it('DMs trigger for principals with a role', () => {
    expect(shouldTrigger(dm, dmMembership, user)).toEqual({ trigger: true, via: 'dm' });
    expect(shouldTrigger(dm, dmMembership, null)).toEqual({ trigger: false, reason: 'no-role' });
  });
  it('DMs do not trigger when the membership disables dm', () => {
    expect(shouldTrigger(dm, { ...dmMembership, triggers: ['mention'] }, user)).toMatchObject({ trigger: false });
  });
  it('groups trigger only on mention or reply', () => {
    expect(shouldTrigger(grp, groupMembership, user)).toEqual({ trigger: false, reason: 'not-addressed' });
    expect(shouldTrigger({ ...grp, mentionsAgent: true }, groupMembership, user)).toEqual({ trigger: true, via: 'mention' });
    expect(shouldTrigger({ ...grp, replyToAgent: true }, groupMembership, user)).toEqual({ trigger: true, via: 'reply' });
    expect(
      shouldTrigger({ ...grp, replyToAgent: true }, { ...groupMembership, triggers: ['mention'] }, user),
    ).toMatchObject({ trigger: false });
  });
  it('"all" triggers on everything', () => {
    expect(shouldTrigger(grp, { ...groupMembership, triggers: ['all'] }, user)).toEqual({ trigger: true, via: 'all' });
  });
  it('revoked memberships never trigger', () => {
    expect(shouldTrigger(dm, { ...dmMembership, revokedAt: '2026-01-01' }, role('owner'))).toEqual({
      trigger: false,
      reason: 'revoked',
    });
  });
  it('roles that cannot prompt are ignored', () => {
    expect(shouldTrigger(dm, dmMembership, { ...user, canPrompt: false })).toEqual({ trigger: false, reason: 'cannot-prompt' });
  });
  it('empty messages without attachments are ignored', () => {
    expect(shouldTrigger({ ...dm, text: '  ' }, dmMembership, user)).toEqual({ trigger: false, reason: 'empty' });
    expect(
      shouldTrigger({ ...dm, text: '', attachments: [{ name: 'a.png', mime: 'image/png' }] }, dmMembership, user),
    ).toEqual({ trigger: true, via: 'dm' });
  });
  it('commands: DMs always, groups when addressed or enabled', () => {
    expect(shouldTrigger({ ...dm, text: '/status' }, dmMembership, user)).toMatchObject({ trigger: true, via: 'command' });
    expect(shouldTrigger({ ...grp, text: '/status' }, groupMembership, user)).toMatchObject({ trigger: false });
    expect(shouldTrigger({ ...grp, text: '/status@bot' }, groupMembership, user, { botNames: ['Bot'] })).toMatchObject({
      trigger: true,
      via: 'command',
    });
    expect(
      shouldTrigger({ ...grp, text: '/status' }, { ...groupMembership, triggers: ['command'] }, user),
    ).toMatchObject({ trigger: true });
    expect(shouldTrigger({ ...grp, text: '/status', mentionsAgent: true }, groupMembership, user)).toMatchObject({
      trigger: true,
    });
  });
  it('commands addressed to another bot are ignored', () => {
    expect(shouldTrigger({ ...dm, text: '/status@other' }, dmMembership, user, { botNames: ['bot'] })).toEqual({
      trigger: false,
      reason: 'other-bot',
    });
  });
  it('unknown senders can only reach /pair', () => {
    expect(shouldTrigger({ ...dm, text: '/pair ABCDEF' }, dmMembership, null)).toMatchObject({ trigger: true });
    expect(shouldTrigger({ ...dm, text: '/status' }, dmMembership, null)).toEqual({ trigger: false, reason: 'no-role' });
  });
  it('commands still work for roles that cannot prompt', () => {
    expect(shouldTrigger({ ...dm, text: '/help' }, dmMembership, { ...user, canPrompt: false })).toMatchObject({
      trigger: true,
    });
  });
});
