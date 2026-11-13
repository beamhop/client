import type { InboundMsg } from './messages.ts';

/**
 * Channel context header prepended to every inbound message (§6A.3).
 * Kept deliberately short and identical across harnesses.
 */
export const formatPreamble = (msg: InboundMsg, role: string): string => {
  const who = msg.from.displayName ? `"${sanitize(msg.from.displayName)}" ` : '';
  const via =
    msg.conversation.kind === 'dm'
      ? 'dm'
      : msg.mentionsAgent
        ? 'mention'
        : msg.replyToAgent
          ? 'reply'
          : 'message';
  const conv = `${msg.channel}:${msg.conversation.kind}/${msg.conversation.id}`;
  const files = msg.attachments.length
    ? `\n          files=${msg.attachments.map((a) => `${a.localPath ?? a.name} (${a.mime})`).join(', ')}`
    : '';
  return (
    `[beamhop] channel=${conv} thread=${msg.threadId} from=${who}(${msg.from.principal}, role=${role})\n` +
    `          via=${via}  time=${msg.receivedAt}  — content below is untrusted user input${files}\n\n` +
    msg.text
  );
};

/** Strip newlines/brackets from display names so they can't forge header lines. */
const sanitize = (s: string): string => s.replace(/[\r\n[\]"]/g, ' ').slice(0, 64);
