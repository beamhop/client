import type { ReactNode } from 'react';
import type { Profile } from '@beamhop/core';
import { displayName, pubkeyFromBech32 } from '@beamhop/core';
import type { ContentToken } from './media.js';

export type ProfileLookup = (pubkey: string) => Profile | undefined;

/**
 * Render the inline token flow (text, NIP-27 `nostr:` mentions, non-media links)
 * into React nodes. Media URLs are handled separately by `PostMedia` — they're
 * already stripped from these tokens by `parseContent`.
 */
export function renderTokens(tokens: readonly ContentToken[], lookup: ProfileLookup): ReactNode[] {
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'text':
        return token.text;
      case 'mention':
        return renderMention(token.token, lookup, i);
      case 'link':
        return (
          <a key={`u${i}`} href={token.url} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent)', wordBreak: 'break-word' }}>
            {prettyUrl(token.url)}
          </a>
        );
      default:
        return null;
    }
  });
}

function renderMention(token: string, lookup: ProfileLookup, key: number): ReactNode {
  const pubkey = pubkeyFromBech32(token);
  if (!pubkey) return `nostr:${token}`;
  const name = displayName(lookup(pubkey), `${token.slice(0, 10)}…`);
  return (
    <span key={`m${key}`} data-testid="mention" style={{ color: 'var(--accent)', fontWeight: 600 }}>
      @{name}
    </span>
  );
}

/** Strip the scheme and a trailing slash for a tidier inline link label. */
function prettyUrl(url: string): string {
  const stripped = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return stripped.length > 48 ? `${stripped.slice(0, 45)}…` : stripped;
}
