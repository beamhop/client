import { z } from 'zod';

/** Channel providers. Plugins may add more ids; known ones are listed for convenience. */
export const KNOWN_PROVIDERS = ['nostr', 'telegram', 'slack', 'discord'] as const;
export type Provider = (typeof KNOWN_PROVIDERS)[number] | (string & {});

/**
 * A principal is "<provider>:<id>", e.g. "nostr:npub1...", "telegram:5551234", "slack:T01/U02".
 * Peer agents are principals too (usually nostr npubs).
 */
export const PrincipalId = z.string().regex(/^[a-z][a-z0-9_-]*:.+$/, 'principal must be "<provider>:<id>"');
export type PrincipalId = z.infer<typeof PrincipalId>;

export const principalId = (provider: string, id: string): PrincipalId => `${provider}:${id}`;
export const parsePrincipal = (p: PrincipalId): { provider: string; id: string } => {
  const i = p.indexOf(':');
  return { provider: p.slice(0, i), id: p.slice(i + 1) };
};

/** Slug used for agent/channel names: lowercase, digits, dash. */
export const Slug = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase letters, digits and dashes');
export type Slug = z.infer<typeof Slug>;

/**
 * A channel target: "<channelName>:<kind>[/<id>]"
 * e.g. "mybot:dm", "mybot:group/-100123", "work-slack:channel/C0123", "nostr:dm", "nostr:group/relay.example/abc".
 */
export const ChannelTarget = z.string().regex(/^[a-z0-9][a-z0-9-]*:(dm|group|channel|thread|public)(\/.+)?$/);
export type ChannelTarget = z.infer<typeof ChannelTarget>;

export const parseTarget = (t: ChannelTarget): { channel: string; kind: string; id?: string } => {
  const [channel, rest = ''] = [t.slice(0, t.indexOf(':')), t.slice(t.indexOf(':') + 1)];
  const slash = rest.indexOf('/');
  return slash === -1
    ? { channel, kind: rest }
    : { channel, kind: rest.slice(0, slash), id: rest.slice(slash + 1) };
};

let counter = 0;
/** Time-sortable unique id with a prefix, e.g. "ses_01J..." (not crypto-secure; use for ids, never secrets). */
export const newId = (prefix: string): string => {
  const t = Date.now().toString(36).padStart(9, '0');
  counter = (counter + 1) % 1679616;
  const c = counter.toString(36).padStart(4, '0');
  const r = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
  return `${prefix}_${t}${c}${r}`;
};
