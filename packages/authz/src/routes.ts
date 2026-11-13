import type { Route } from '@beamhop/core';
import { globMatch } from './glob.ts';

/** Channel name and kind are case-insensitive; conversation ids keep their case. */
const normTarget = (t: string): string => {
  const s = t.trim().normalize('NFC');
  const colon = s.indexOf(':');
  if (colon < 0) return s.toLowerCase();
  const rest = s.slice(colon + 1);
  const slash = rest.indexOf('/');
  const kind = slash < 0 ? rest : rest.slice(0, slash);
  const id = slash < 0 ? '' : rest.slice(slash);
  return `${s.slice(0, colon).toLowerCase()}:${kind.toLowerCase()}${id}`;
};

const matches = (pattern: string, target: string): boolean =>
  globMatch(normTarget(pattern), normTarget(target), { caseInsensitive: false });

export type RouteCheck = { ok: true; via: 'reply' | 'route'; route?: Route } | { ok: false; reason: string };

/**
 * May an agent triggered in `from` post to `to` (§7A)? Default is reply-only: the same conversation.
 * Anything else needs an owner-set route; route targets may use `*` globs (e.g. "work-slack:channel/*").
 */
export const canRouteDetailed = (from: string, to: string, routes: readonly Route[] = []): RouteCheck => {
  if (normTarget(from) === normTarget(to)) return { ok: true, via: 'reply' };
  const route = routes.find((r) => matches(r.from, from) && matches(r.to, to));
  if (route) return { ok: true, via: 'route', route };
  return { ok: false, reason: `no route from ${from} to ${to}` };
};

export const canRoute = (from: string, to: string, routes: readonly Route[] = []): boolean =>
  canRouteDetailed(from, to, routes).ok;
