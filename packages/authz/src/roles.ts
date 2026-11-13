import {
  type AgentConfig,
  type BeamhopConfig,
  DEFAULT_ROLES,
  type Membership,
  type RoleDef,
  type RoleName,
} from '@beamhop/core';
import { canonicalNostrId } from './nostr-key.ts';

/** Providers whose ids are case-insensitive in practice (bech32/hex, numeric, upper-case ids). */
const CASE_INSENSITIVE_PROVIDERS = new Set(['nostr', 'telegram', 'discord', 'slack']);

/**
 * Canonical form of a principal for comparisons: trimmed, NFC-normalized, provider lower-cased,
 * and the id lower-cased for providers with case-insensitive ids. Nostr keys are canonicalized to
 * the npub form, so `nostr:<hex>`, `nostr:npub1…` and `nostr:nostr:npub1…` are the same principal.
 */
export const normalizePrincipal = (p: string): string => {
  const s = p.trim().normalize('NFC');
  const i = s.indexOf(':');
  if (i <= 0) return s.toLowerCase();
  const provider = s.slice(0, i).toLowerCase();
  const id = s.slice(i + 1);
  if (provider === 'nostr') return `nostr:${canonicalNostrId(id) ?? id.trim().toLowerCase()}`;
  return `${provider}:${CASE_INSENSITIVE_PROVIDERS.has(provider) ? id.toLowerCase() : id}`;
};

export const samePrincipal = (a: string, b: string): boolean =>
  normalizePrincipal(a) === normalizePrincipal(b);

const includesPrincipal = (list: readonly string[], p: string): boolean => {
  const n = normalizePrincipal(p);
  return list.some((x) => normalizePrincipal(x) === n);
};

/** Look a principal up in a grants record, tolerant of case/normalization differences in keys. */
const lookupGrant = (grants: Record<string, RoleName>, key: string): RoleName | undefined => {
  if (Object.hasOwn(grants, key)) return grants[key];
  const n = normalizePrincipal(key);
  for (const [k, v] of Object.entries(grants)) if (normalizePrincipal(k) === n) return v;
  return undefined;
};

/** Mesh allow/block entries may be bare npubs/hex keys or full principals ("nostr:npub1..."). */
const meshListHas = (list: readonly string[], principal: string): boolean => {
  const n = normalizePrincipal(principal);
  const bare = n.includes(':') ? n.slice(n.indexOf(':') + 1) : n;
  return list.some((entry) => {
    const t = entry.trim();
    // A bare npub / hex key means that Nostr principal, whichever form either side uses.
    const nostr = t.includes(':') ? undefined : canonicalNostrId(t);
    if (nostr) return n === `nostr:${nostr}`;
    const e = t.includes(':') ? normalizePrincipal(t) : t.toLowerCase();
    return e === n || e === bare;
  });
};

export type RoleSource =
  | 'owner'
  | 'agent-grant'
  | 'global-grant'
  | 'person-grant'
  | 'membership'
  | 'public'
  | 'peer'
  | 'peer-allowed';

export type RoleDenial = 'blocked' | 'revoked-membership' | 'unknown-sender' | 'no-membership';

export type RoleResolution =
  | { role: RoleName; source: RoleSource; person?: string }
  | { role: null; reason: RoleDenial };

export interface ResolveRoleInput {
  principal: string;
  agent: Pick<AgentConfig, 'grants' | 'public' | 'mesh'>;
  global: Pick<BeamhopConfig, 'owners' | 'grants' | 'people'>;
  /** Membership the message arrived through. Omit for the control plane (PWA/CLI). */
  membership?: Membership;
  /** The sender is a peer agent (mesh / bot message). */
  isAgent?: boolean;
}

/** Person ids the principal is linked to (§6 linked identities). */
export const linkedPeople = (people: Record<string, string[]>, principal: string): string[] =>
  Object.entries(people)
    .filter(([, ps]) => includesPrincipal(ps, principal))
    .map(([person]) => person);

/**
 * Resolve the effective role of a principal for an agent (§6, §6A.6).
 *
 * Order: owners → blocked peers → agent grants → global grants → linked identity grants →
 * (membership revoked → nothing) → peer-agent default → membership default (groups) → public (DMs).
 */
export const resolveRoleDetailed = (input: ResolveRoleInput): RoleResolution => {
  const { principal, agent, global, membership } = input;
  const people = linkedPeople(global.people ?? {}, principal);
  const linked = people.flatMap((p) => global.people[p] ?? []);
  const owners = global.owners ?? [];

  if (includesPrincipal(owners, principal)) return { role: 'owner', source: 'owner' };
  for (const person of people) {
    if ((global.people[person] ?? []).some((p) => includesPrincipal(owners, p)))
      return { role: 'owner', source: 'owner', person };
  }

  if (meshListHas(agent.mesh?.block ?? [], principal)) return { role: null, reason: 'blocked' };
  if (membership?.revokedAt) return { role: null, reason: 'revoked-membership' };

  const agentGrants = agent.grants ?? {};
  const globalGrants = global.grants ?? {};
  const direct = lookupGrant(agentGrants, principal);
  if (direct) return { role: direct, source: 'agent-grant' };
  const g = lookupGrant(globalGrants, principal);
  if (g) return { role: g, source: 'global-grant' };

  for (const person of people) {
    const byPerson = lookupGrant(agentGrants, person) ?? lookupGrant(globalGrants, person);
    if (byPerson) return { role: byPerson, source: 'person-grant', person };
    for (const other of linked) {
      const r = lookupGrant(agentGrants, other) ?? lookupGrant(globalGrants, other);
      if (r) return { role: r, source: 'person-grant', person };
    }
  }

  if (input.isAgent) {
    if (meshListHas(agent.mesh?.allow ?? [], principal) && membership)
      return { role: membership.defaultRole, source: 'peer-allowed' };
    return { role: 'agent', source: 'peer' };
  }

  if (!membership) return { role: null, reason: 'no-membership' };
  const kind = membership.target.slice(membership.target.indexOf(':') + 1).split('/')[0];
  if (kind !== 'dm') return { role: membership.defaultRole, source: 'membership' };
  if (agent.public) return { role: 'viewer', source: 'public' };
  return { role: null, reason: 'unknown-sender' };
};

export const resolveRole = (input: ResolveRoleInput): RoleName | null => resolveRoleDetailed(input).role;

/** A role override as it appears in config: any subset of fields, plus the name. */
export type RoleOverride = Partial<Omit<RoleDef, 'tools' | 'budget'>> & {
  name: string;
  tools?: Partial<RoleDef['tools']>;
  budget?: Partial<RoleDef['budget']>;
};

/** Base used for brand-new custom roles: the most restrictive built-in. */
const CUSTOM_BASE = DEFAULT_ROLES.find((r) => r.name === 'viewer')!;

/**
 * The effective definition of a role: DEFAULT_ROLES merged with any override of the same name.
 * New custom roles start from the `viewer` defaults. Returns null for an unknown role.
 * Invariants that cannot be overridden: the owner can always prompt and approve; peer agents never approve or reconfigure.
 */
export const effectiveRoleDef = (name: string, customRoles: readonly RoleOverride[] = []): RoleDef | null => {
  const builtin = DEFAULT_ROLES.find((r) => r.name === name);
  const override = customRoles.find((r) => r.name === name);
  if (!builtin && !override) return null;
  const base = builtin ?? { ...CUSTOM_BASE, description: '' };
  const merged: RoleDef = {
    ...base,
    ...stripUndefined(override ?? {}),
    name,
    tools: {
      allow: override?.tools?.allow ?? base.tools.allow,
      deny: override?.tools?.deny ?? base.tools.deny,
    },
    budget: { ...base.budget, ...stripUndefined(override?.budget ?? {}) },
  };
  if (name === 'owner') {
    merged.canApprove = true;
    merged.canPrompt = true;
  }
  if (name === 'agent') {
    merged.canApprove = false;
    merged.canReconfigure = false;
  }
  return merged;
};

const stripUndefined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** All effective roles (built-ins plus custom), for listings. */
export const allRoleDefs = (customRoles: readonly RoleOverride[] = []): RoleDef[] => {
  const names = [...new Set([...DEFAULT_ROLES.map((r) => r.name), ...customRoles.map((r) => r.name)])];
  return names.map((n) => effectiveRoleDef(n, customRoles)!);
};
