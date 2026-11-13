/**
 * Decides which transport the PWA talks to (README § Data layer, § Hosted mode):
 *
 *  - `#token=<api token>` in the URL → stored in localStorage (`bh.token`) and stripped from the URL
 *    (history.replaceState) → local daemon over WebSocket at `location.origin` (or `?daemon=<url>`).
 *  - `?mock=1` (sticky for the tab) → in-browser mock daemon with demo data.
 *    `?still=1` additionally freezes the mock's timers (stable screenshots/tests).
 *  - `?mock=0` forgets the sticky mock choice.
 *  - An active saved daemon (daemons.ts, written by a successful pairing) → hosted mode over the Nostr
 *    control plane (nostr.ts).
 *  - A stored token (and no saved daemon) → local daemon.
 *  - Nothing: dev builds → mock (demo data); production → `none` (the shell shows the pair prompt).
 *
 * Order: mock param > `#token` in the URL > saved daemon > stored token > dev mock / none.
 */
import { getActiveDaemon, type SavedDaemon } from './daemons.ts';

export type ConnectionKind = 'mock' | 'local' | 'nostr' | 'none';
export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface ConnectionConfig {
  kind: ConnectionKind;
  /** Daemon base URL for `local` (http(s)://host:port). */
  baseUrl?: string;
  token?: string;
  /** Mock only: run the live simulator (streaming sessions, new approvals…). */
  live?: boolean;
  /** Mock only: methods that should fail (error-state development), from `?mockFail=a,b`. */
  failMethods?: string[];
  /** Hosted (`nostr`) only: the saved daemon this runtime talks to. */
  daemon?: SavedDaemon;
  /**
   * Why this connection was chosen (shown in Settings → About and the demo banner).
   * `no-token`: dev fallback to the mock. `unpaired`: production with nothing to connect to.
   */
  reason: 'token' | 'mock-param' | 'no-token' | 'saved-daemon' | 'unpaired';
}

export interface ResolveOptions {
  /** Dev builds fall back to the mock; production shows the pair prompt (default import.meta.env.DEV). */
  dev?: boolean;
}

const TOKEN_KEY = 'bh.token';
const DAEMON_KEY = 'bh.daemon';
const MOCK_KEY = 'bh.mock';
const STILL_KEY = 'bh.still';

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export const resolveConnection = (
  loc: Location = window.location,
  opts: ResolveOptions = {},
): ConnectionConfig => {
  const dev = opts.dev ?? import.meta.env?.DEV ?? false;
  const search = new URLSearchParams(loc.search);
  const hash = new URLSearchParams(loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash);

  const hashToken = hash.get('token');
  if (hashToken) {
    safe(() => localStorage.setItem(TOKEN_KEY, hashToken), undefined);
    hash.delete('token');
    const rest = hash.toString();
    // Strip the secret from the address bar and history.
    safe(
      () => history.replaceState(history.state, '', `${loc.pathname}${loc.search}${rest ? `#${rest}` : ''}`),
      undefined,
    );
  }

  const daemon = search.get('daemon');
  if (daemon) safe(() => localStorage.setItem(DAEMON_KEY, daemon), undefined);

  const mockParam = search.get('mock');
  if (mockParam === '1') safe(() => sessionStorage.setItem(MOCK_KEY, '1'), undefined);
  if (mockParam === '0') safe(() => sessionStorage.removeItem(MOCK_KEY), undefined);
  const still = search.get('still');
  if (still === '1') safe(() => sessionStorage.setItem(STILL_KEY, '1'), undefined);
  if (still === '0') safe(() => sessionStorage.removeItem(STILL_KEY), undefined);

  const stickyMock = safe(() => sessionStorage.getItem(MOCK_KEY) === '1', false);
  const isStill = safe(() => sessionStorage.getItem(STILL_KEY) === '1', false);
  const token = hashToken ?? safe(() => localStorage.getItem(TOKEN_KEY) ?? undefined, undefined);
  const failMethods = (search.get('mockFail') ?? '').split(',').filter(Boolean);

  if (stickyMock || mockParam === '1') {
    return { kind: 'mock', live: !isStill, failMethods, reason: 'mock-param' };
  }
  const local = (t: string): ConnectionConfig => {
    const baseUrl = safe(() => localStorage.getItem(DAEMON_KEY), null) ?? loc.origin;
    return { kind: 'local', baseUrl, token: t, reason: 'token' };
  };
  if (hashToken) return local(hashToken);
  const saved = safe(() => getActiveDaemon(), undefined);
  if (saved) return { kind: 'nostr', daemon: saved, reason: 'saved-daemon' };
  if (token) return local(token);
  if (dev) return { kind: 'mock', live: !isStill, failMethods, reason: 'no-token' };
  return { kind: 'none', reason: 'unpaired' };
};

/** Forget the stored daemon token (Settings → About → Disconnect). */
export const forgetToken = (): void => {
  safe(() => localStorage.removeItem(TOKEN_KEY), undefined);
};
