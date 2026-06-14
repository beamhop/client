import { useSyncExternalStore } from 'react';
import { encodeNpub, encodeNevent, pubkeyFromBech32, eventIdFromBech32 } from '@beamhop/core';

/**
 * The single source of truth for "where am I". Identifiers are kept as hex
 * internally (what the rest of the app uses) and only encoded to bech32 at the
 * URL boundary so links stay portable across Nostr clients.
 */
/** Which kind of result an Explore search is scoped to. */
export type SearchType = 'posts' | 'people';

export type Route =
  | { name: 'home' }
  | { name: 'explore'; q: string; type: SearchType }
  | { name: 'messages'; peer: string | null }
  | { name: 'profile'; pubkey: string | null }
  | { name: 'note'; id: string }
  | { name: 'security' };

/** Parse a `location.hash` value (e.g. `#/profile/npub1…`) into a Route. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '');
  const [path = '', queryString = ''] = raw.split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(queryString);

  switch (segments[0]) {
    case 'explore':
      return {
        name: 'explore',
        q: params.get('q') ?? '',
        type: params.get('type') === 'people' ? 'people' : 'posts',
      };
    case 'messages':
      return { name: 'messages', peer: segments[1] ? pubkeyFromBech32(segments[1]) : null };
    case 'profile':
      return { name: 'profile', pubkey: segments[1] ? pubkeyFromBech32(segments[1]) : null };
    case 'note': {
      const id = segments[1] ? eventIdFromBech32(segments[1]) : null;
      return id ? { name: 'note', id } : { name: 'home' };
    }
    case 'security':
      return { name: 'security' };
    default:
      return { name: 'home' };
  }
}

/** Serialize a Route back into a `#/…` hash, encoding ids as bech32. */
export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/home';
    case 'explore': {
      const params = new URLSearchParams();
      if (route.q) params.set('q', route.q);
      if (route.type !== 'posts') params.set('type', route.type); // 'posts' is the default
      const qs = params.toString();
      return qs ? `#/explore?${qs}` : '#/explore';
    }
    case 'messages':
      return route.peer ? `#/messages/${encodeNpub(route.peer)}` : '#/messages';
    case 'profile':
      return route.pubkey ? `#/profile/${encodeNpub(route.pubkey)}` : '#/profile';
    case 'note':
      return `#/note/${encodeNevent(route.id)}`;
    case 'security':
      return '#/security';
  }
}

/**
 * Navigate to a route. `replace` swaps the current history entry instead of
 * pushing a new one (used for auto-selection that shouldn't trap the back
 * button). `replaceState` doesn't fire `hashchange`, so we dispatch it manually.
 */
export function navigateTo(route: Route, replace = false): void {
  const target = routeToHash(route);
  if (replace) {
    history.replaceState(null, '', target);
    window.dispatchEvent(new Event('hashchange'));
  } else if (window.location.hash !== target) {
    window.location.hash = target;
  } else {
    // Re-asserting the same route (e.g. re-opening the active thread) still
    // needs to notify subscribers since assigning an unchanged hash is a no-op.
    window.dispatchEvent(new Event('hashchange'));
  }
}

const subscribe = (cb: () => void): (() => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};

/** Subscribe to the current location hash (re-renders on every navigation). */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}
