/**
 * Minimal bot permissions and OAuth2 invite URL.
 *
 * Bit positions from https://discord.com/developers/docs/topics/permissions#permissions-bitwise-permission-flags
 * Invite URL format: https://discord.com/developers/docs/topics/oauth2#bot-authorization-flow
 */
export const DISCORD_PERMISSION_BITS = {
  AddReactions: 1n << 6n, //                 64
  ViewChannel: 1n << 10n, //               1024
  SendMessages: 1n << 11n, //              2048
  AttachFiles: 1n << 15n, //              32768
  ReadMessageHistory: 1n << 16n, //       65536
  UseApplicationCommands: 1n << 31n, // 2147483648
  SendMessagesInThreads: 1n << 38n, // 274877906944
} as const;

export const DISCORD_MIN_PERMISSIONS: bigint = Object.values(DISCORD_PERMISSION_BITS).reduce(
  (a, b) => a | b,
  0n,
);

export const discordInviteUrl = (
  applicationId: string,
  permissions: bigint = DISCORD_MIN_PERMISSIONS,
): string => {
  if (!/^\d{15,22}$/.test(applicationId)) throw new RangeError('invalid Discord application id');
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=${permissions.toString()}`;
};

/**
 * Bot tokens are `base64(application id).<timestamp>.<hmac>`; the first segment decodes
 * to the bot's user id (= application id). Used only to prefill the invite URL.
 */
export const applicationIdFromToken = (token: string): string | undefined => {
  const first = token.split('.')[0];
  if (!first) return undefined;
  try {
    const id = Buffer.from(first.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^\d{15,22}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
};

/** Application flags: https://discord.com/developers/docs/resources/application#application-object-application-flags */
export const APP_FLAG_GATEWAY_MESSAGE_CONTENT = 1 << 19;
export const APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 18;
