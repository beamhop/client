import type { MethodName, Params } from '@beamhop/core';

/**
 * Query keys are `['bh', method, params]`. Everything beamhop caches lives under `['bh']`,
 * so `invalidateQueries({ queryKey: ['bh', 'agent.list'] })` hits every agent.list variant.
 */
export const apiKey = <M extends MethodName>(method: M, params?: Params<M>) =>
  ['bh', method, (params ?? {}) as object] as const;

export const methodKey = (method: MethodName) => ['bh', method] as const;

/**
 * Which cached reads a successful mutation makes stale. Keyed by full method name or namespace (`agent.*`).
 * Live server events patch caches directly (events.ts); this is the fallback for request/response.
 */
export const INVALIDATES: Record<string, MethodName[] | 'all'> = {
  'system.panic': 'all',
  'system.resume': 'all',
  'agent.*': ['agent.list', 'agent.get', 'system.status', 'identity.get'],
  'membership.*': ['agent.list', 'agent.get'],
  'channel.*': ['channel.list', 'system.status'],
  'session.*': ['session.list', 'session.events', 'agent.list'],
  'approval.*': ['approval.list', 'system.status'],
  'role.*': ['role.list'],
  'owner.*': ['role.list', 'system.status'],
  'principal.*': ['role.list'],
  'policy.*': ['policy.get', 'policy.suggestions', 'approval.list'],
  'secret.*': ['secret.list'],
  'schedule.*': ['schedule.list'],
  'deploy.*': ['deploy.list', 'agent.list'],
  'device.*': ['device.list'],
  'harness.*': ['harness.list', 'harness.scan'],
  'identity.*': ['identity.get'],
  'data.purge': ['audit.query', 'usage.query', 'session.list'],
};

export const invalidationsFor = (method: MethodName): MethodName[] | 'all' => {
  const exact = INVALIDATES[method];
  if (exact) return exact;
  const ns = `${method.split('.')[0]}.*`;
  return INVALIDATES[ns] ?? [];
};
