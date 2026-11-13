import type { InboundMsg, Membership, RoleDef, Trigger } from '@beamhop/core';
import { isAddressedTo, type ParsedCommand, parseCommand } from './commands.ts';

export type TriggerVia = Exclude<Trigger, 'all'> | 'all';

export type TriggerDecision =
  | { trigger: true; via: TriggerVia; command?: ParsedCommand }
  | {
      trigger: false;
      reason:
        | 'no-role'
        | 'revoked'
        | 'cannot-prompt'
        | 'not-addressed'
        | 'other-bot'
        | 'trigger-disabled'
        | 'empty';
    };

export interface ShouldTriggerOptions {
  /** Names this bot answers to in `/cmd@name` (handle, username). */
  botNames?: readonly string[];
}

type Msg = Pick<InboundMsg, 'conversation' | 'text' | 'mentionsAgent' | 'replyToAgent'> & {
  attachments?: InboundMsg['attachments'];
};

/**
 * Should this inbound message reach the agent (§6A.4)?
 * DMs: every message from a principal with a role. Groups: only @mentions and replies (and commands
 * when the membership enables them, or when addressed as `/cmd@thisbot`). Ignored messages cost nothing.
 */
export const shouldTrigger = (
  msg: Msg,
  membership: Pick<Membership, 'triggers' | 'revokedAt'>,
  role: Pick<RoleDef, 'canPrompt' | 'commands'> | null,
  opts: ShouldTriggerOptions = {},
): TriggerDecision => {
  if (membership.revokedAt) return { trigger: false, reason: 'revoked' };
  const parsed = parseCommand(msg.text);
  const triggers = new Set(membership.triggers);
  const isDm = msg.conversation.kind === 'dm';

  if (parsed) {
    if (!isAddressedTo(parsed, opts.botNames ?? [])) return { trigger: false, reason: 'other-bot' };
    // Unknown senders may still /pair; everything else needs a role.
    if (!role && !(parsed.ok && parsed.command.name === 'pair')) return { trigger: false, reason: 'no-role' };
    const explicitlyAddressed = Boolean(parsed.addressedTo);
    if (
      isDm ||
      explicitlyAddressed ||
      triggers.has('command') ||
      triggers.has('all') ||
      (msg.mentionsAgent && triggers.has('mention')) ||
      (msg.replyToAgent && triggers.has('reply'))
    )
      return { trigger: true, via: 'command', command: parsed };
    return { trigger: false, reason: 'not-addressed' };
  }

  if (!role) return { trigger: false, reason: 'no-role' };
  if (!role.canPrompt) return { trigger: false, reason: 'cannot-prompt' };
  if (!msg.text.trim() && !(msg.attachments && msg.attachments.length > 0))
    return { trigger: false, reason: 'empty' };

  if (isDm) {
    if (triggers.has('dm') || triggers.has('all')) return { trigger: true, via: 'dm' };
    return { trigger: false, reason: 'trigger-disabled' };
  }
  if (triggers.has('all')) return { trigger: true, via: 'all' };
  if (msg.mentionsAgent && triggers.has('mention')) return { trigger: true, via: 'mention' };
  if (msg.replyToAgent && triggers.has('reply')) return { trigger: true, via: 'reply' };
  return { trigger: false, reason: 'not-addressed' };
};
