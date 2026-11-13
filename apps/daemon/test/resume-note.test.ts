import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

describe('system.resume', () => {
  it("keeps the owner's note with the resume event in the audit log", async () => {
    env = await makeEnv();
    await env.client.call('system.panic', { reason: 'test' });
    await env.client.call('system.resume', { note: 'false alarm, the deploy was mine' });
    const ev = env.d.store.audit.query({ limit: 50 }).find((e) => e.type === 'panic.resume');
    expect(ev?.summary).toBe('Resumed after panic: false alarm, the deploy was mine');
    expect(ev?.data).toMatchObject({ note: 'false alarm, the deploy was mine' });
  });

  it('works without a note, as before', async () => {
    env = await makeEnv();
    await env.client.call('system.panic', { reason: 'test' });
    await env.client.call('system.resume', {});
    const ev = env.d.store.audit.query({ limit: 50 }).find((e) => e.type === 'panic.resume');
    expect(ev?.summary).toBe('Resumed after panic');
  });
});
