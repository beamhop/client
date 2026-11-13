/**
 * harness.models: the daemon asks the harness itself (a throwaway session, no prompt), caches the list,
 * and says why when it cannot list them.
 */
import type { ModelOption } from '@beamhop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHarnessPlugin, makeEnv, type TestEnv } from './helpers.ts';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

/** A fake harness whose sessions list `models` (or cannot list, when undefined). */
const withModels = (models: ModelOption[] | undefined, id: string) => {
  const h = new FakeHarnessPlugin(undefined, id);
  const start = h.start.bind(h);
  h.start = async (spec) => {
    const s = await start(spec);
    return models ? Object.assign(s, { models: async () => models }) : s;
  };
  return h;
};

describe('harness.models', () => {
  it('lists, caches and refreshes the models the harness reports', async () => {
    const models = [
      { id: 'big', label: 'Big', isDefault: true },
      { id: 'small', label: 'Small', description: 'fast' },
    ];
    env = await makeEnv({ harness: withModels(models, 'listing') });
    expect(await env.client.call('harness.models', { id: 'listing' })).toEqual({ models });
    expect(env.harness.sessions).toHaveLength(1);
    // Served from the cache: the harness is not started again.
    await env.client.call('harness.models', { id: 'listing' });
    expect(env.harness.sessions).toHaveLength(1);
    await env.client.call('harness.models', { id: 'listing', refresh: true });
    expect(env.harness.sessions).toHaveLength(2);
    // The throwaway session is closed and its directory removed.
    expect(env.harness.sessions.every((s) => s.closed)).toBe(true);
  });

  it('explains when the harness cannot list or is not installed', async () => {
    env = await makeEnv({ harness: withModels(undefined, 'plain') });
    const r = await env.client.call('harness.models', { id: 'plain', refresh: true });
    expect(r.models).toEqual([]);
    expect(r.error).toMatch(/cannot list its models/);
    const missing = await env.client.call('harness.models', { id: 'nope' });
    expect(missing).toEqual({ models: [], error: 'nope is not installed' });
  });
});
