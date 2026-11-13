import type { PermissionMode, RoleDef } from '@beamhop/core';
import { modeRank } from './tools.ts';

export const COMMAND_NAMES = [
  'new',
  'stop',
  'status',
  'resume',
  'details',
  'approve',
  'deny',
  'model',
  'harness',
  'mode',
  'usage',
  'pair',
  'help',
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export const SESSION_MODES = ['plan', 'auto', 'read-only'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export type Command =
  | { name: 'new' | 'stop' | 'status' | 'resume' | 'details' | 'usage' | 'help'; args: string[] }
  | { name: 'approve' | 'deny'; id: string; args: string[] }
  | { name: 'model'; model?: string; args: string[] }
  | { name: 'harness'; harness?: string; args: string[] }
  | { name: 'mode'; mode?: SessionMode; args: string[] }
  | { name: 'pair'; code: string; args: string[] };

export type ParsedCommand =
  | { ok: true; command: Command; addressedTo?: string }
  | { ok: false; name: string; error: string; known: boolean; addressedTo?: string };

export const COMMAND_HELP: Record<CommandName, string> = {
  new: 'Start a new session',
  stop: 'Stop the current run',
  status: 'Show session and agent status',
  resume: 'Resume the last session',
  details: 'Show hidden tool calls',
  approve: 'Approve a pending action: /approve <id>',
  deny: 'Deny a pending action: /deny <id>',
  model: 'Show or switch the model: /model <id>',
  harness: 'Show or switch the harness: /harness <id>',
  mode: 'Switch mode: /mode plan|auto|read-only',
  usage: 'Tokens, cost and minutes left',
  pair: 'Link this account with a pairing code: /pair <code>',
  help: 'List commands',
};

// "/name", optional "@botname" (Telegram style), then whitespace or end.
const COMMAND_RE = /^\/([\p{L}][\p{L}\p{N}_]*)(?:@([\p{L}\p{N}_.-]+))?(?=\s|$)([\s\S]*)$/u;

/**
 * Parse an in-channel command (§6A.7). Returns null when the text is not a command at all.
 * Names are case-insensitive; `/cmd@botname` is supported (the bot name is returned in `addressedTo`).
 */
export const parseCommand = (text: string): ParsedCommand | null => {
  const m = COMMAND_RE.exec(text.normalize('NFC').trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const addressedTo = m[2];
  const argText = (m[3] ?? '').trim();
  const args = argText ? argText.split(/\s+/) : [];
  const at = addressedTo ? { addressedTo } : {};
  const fail = (error: string, known = true): ParsedCommand => ({ ok: false, name, error, known, ...at });
  if (!(COMMAND_NAMES as readonly string[]).includes(name)) return fail(`unknown command /${name}`, false);
  const n = name as CommandName;
  switch (n) {
    case 'approve':
    case 'deny':
      if (!args[0]) return fail(`usage: /${n} <id>`);
      return { ok: true, command: { name: n, id: args[0], args }, ...at };
    case 'model':
      return { ok: true, command: args[0] ? { name: n, model: args[0], args } : { name: n, args }, ...at };
    case 'harness':
      return { ok: true, command: args[0] ? { name: n, harness: args[0], args } : { name: n, args }, ...at };
    case 'mode': {
      if (!args[0]) return { ok: true, command: { name: n, args }, ...at };
      const mode = args[0].toLowerCase().replace(/^readonly$/, 'read-only');
      if (!(SESSION_MODES as readonly string[]).includes(mode))
        return fail('usage: /mode plan|auto|read-only');
      return { ok: true, command: { name: n, mode: mode as SessionMode, args }, ...at };
    }
    case 'pair': {
      const code = args.join('');
      if (!code) return fail('usage: /pair <code>');
      return { ok: true, command: { name: n, code, args }, ...at };
    }
    default:
      return { ok: true, command: { name: n, args }, ...at };
  }
};

/** Is a `/cmd@name` addressed to this bot (or to nobody in particular)? Case-insensitive. */
export const isAddressedTo = (parsed: { addressedTo?: string }, botNames: readonly string[]): boolean => {
  if (!parsed.addressedTo) return true;
  const want = parsed.addressedTo.normalize('NFC').toLowerCase().replace(/^@/, '');
  return botNames.some((b) => b.normalize('NFC').toLowerCase().replace(/^@/, '') === want);
};

export type CommandAuth = { allowed: true } | { allowed: false; reason: string };

/**
 * May this role run this command? `role` is null for unknown senders, who may only `/pair`.
 * Changing model/harness/mode needs `canReconfigure`; `/mode` cannot loosen past the role's own mode
 * (owners excepted); approvals need `canApprove`.
 */
export const authorizeCommand = (
  role: Pick<RoleDef, 'name' | 'commands' | 'canReconfigure' | 'canApprove' | 'permissionMode'> | null,
  cmd: Command,
): CommandAuth => {
  if (!role) return cmd.name === 'pair' ? { allowed: true } : { allowed: false, reason: 'unknown sender' };
  if (!role.commands.map((c) => c.toLowerCase()).includes(cmd.name))
    return { allowed: false, reason: `/${cmd.name} is not available to role ${role.name}` };
  if ((cmd.name === 'approve' || cmd.name === 'deny') && !role.canApprove)
    return { allowed: false, reason: `role ${role.name} cannot approve` };
  const changes =
    (cmd.name === 'model' && cmd.model) ||
    (cmd.name === 'harness' && cmd.harness) ||
    (cmd.name === 'mode' && cmd.mode);
  if (changes && !role.canReconfigure)
    return { allowed: false, reason: `role ${role.name} cannot reconfigure` };
  if (cmd.name === 'mode' && cmd.mode && role.name !== 'owner') {
    if (modeRank(cmd.mode as PermissionMode) > modeRank(role.permissionMode))
      return {
        allowed: false,
        reason: `mode ${cmd.mode} is above the ${role.permissionMode} limit of ${role.name}`,
      };
  }
  return { allowed: true };
};

/** Help text listing only the commands the role can use. */
export const helpText = (role: Pick<RoleDef, 'commands'> | null): string => {
  const names = role ? COMMAND_NAMES.filter((c) => role.commands.includes(c)) : (['pair'] as const);
  return names.map((c) => `/${c} — ${COMMAND_HELP[c]}`).join('\n');
};
