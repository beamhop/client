import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DeployState, FLY_SIZES, FlyDeployer } from '../src/index.ts';
import {
  FakeApi,
  memorySecrets,
  noSleep,
  OWNER_NPUB,
  PROVISIONING_PUBKEY,
  provisioning,
  spec,
  tmpState,
} from './helpers.ts';

const TOKEN = ['FlyV1 fm2', 'lJPECAAAAAAAAAAAxBDexampleexampleexampleexample'].join('_');

describe('FlyDeployer', () => {
  let api: FakeApi;
  let state: DeployState;
  let apps: Set<string>;
  // biome-ignore lint/suspicious/noExplicitAny: fake machine records
  let machines: any[];
  let volumes: { id: string; name: string; region: string }[];

  const make = (extra: Partial<ConstructorParameters<typeof FlyDeployer>[0]> = {}) =>
    new FlyDeployer({
      secrets: memorySecrets({ 'deploy.fly.token': TOKEN }),
      provisioning: () => provisioning(),
      state,
      baseUrl: api.baseUrl,
      sleep: noSleep,
      ...extra,
    });

  beforeEach(async () => {
    api = new FakeApi();
    apps = new Set();
    machines = [];
    volumes = [];
    api
      .on('GET', '/apps/:app', (_r, p) =>
        apps.has(p.app!)
          ? { body: { name: p.app, status: 'deployed' } }
          : { status: 404, body: { error: 'Not Found' } },
      )
      .on('POST', '/apps', (r) => {
        apps.add(r.body.app_name);
        return { status: 201 };
      })
      .on('GET', '/apps/:app/volumes', () => ({ body: volumes }))
      .on('POST', '/apps/:app/volumes', (r) => {
        const v = {
          id: 'vol_4y5gkog8n7rrxl1r',
          name: r.body.name,
          region: r.body.region,
          size_gb: r.body.size_gb,
        };
        volumes.push(v);
        return { body: v };
      })
      .on('GET', '/apps/:app/machines', () => ({ body: machines }))
      .on('POST', '/apps/:app/machines', (r) => {
        const m = {
          id: '3d8d9e1fe12389',
          name: r.body.name,
          state: 'created',
          region: r.body.region,
          created_at: '2026-11-13T00:00:00Z',
          private_ip: 'fdaa:0:1::3',
          config: r.body.config,
        };
        machines.push(m);
        return { body: m };
      })
      .on('DELETE', '/apps/:app/machines/:id', () => {
        machines = [];
        return { body: { ok: true } };
      })
      .on('DELETE', '/apps/:app', (_r, p) => {
        apps.delete(p.app!);
        return { status: 202 };
      });
    await api.start();
    state = await tmpState();
  });
  afterEach(() => api.close());

  it('publishes sizes and regions without API calls', async () => {
    const d = make();
    const s = await d.sizes();
    expect(s.find((x) => x.id === 'shared-cpu-1x-256mb')!.monthlyUsd).toBe(2.19);
    expect(s.find((x) => x.id === 'shared-cpu-1x-1gb')!.monthlyUsd).toBe(6.7);
    expect((await d.regions()).some((r) => r.id === 'fra')).toBe(true);
    expect(api.requests).toHaveLength(0);
  });

  it('plan: machine + volume cost, Firecracker note, small-RAM warning', async () => {
    const plan = await make().plan(spec('fly'));
    expect(plan.monthlyCostUsd).toBe(6.85); // 6.70 + 1 GB × 0.15
    expect(plan.actions.map((a) => a.resource)).toEqual([
      'app/beamhop-reviewer',
      'volume/beamhop_data',
      'machine/beamhop-reviewer',
    ]);
    expect(plan.warnings.join(' ')).toMatch(/Firecracker/);
    const small = await make({ volumeGb: 3 }).plan(spec('fly', { size: 'shared-cpu-1x-256mb' }));
    expect(small.monthlyCostUsd).toBe(2.64);
    expect(small.warnings.join(' ')).toMatch(/too small/);
  });

  it('apply creates app, encrypted volume and a machine with no services', async () => {
    const dep = await make({ orgSlug: 'my-org' }).apply(spec('fly', { harnesses: ['claude', 'codex'] }));
    expect(dep).toMatchObject({
      id: 'fly:reviewer',
      status: 'provisioning',
      region: 'fra',
      size: 'shared-cpu-1x-1gb',
    });

    const auth = api.requests.map((r) => r.headers.authorization);
    expect(new Set(auth)).toEqual(new Set([TOKEN])); // FlyV1 macaroon sent as-is

    expect(api.calls('POST', '/apps')[0]!.body).toEqual({ app_name: 'beamhop-reviewer', org_slug: 'my-org' });
    expect(api.calls('POST', '/apps/beamhop-reviewer/volumes')[0]!.body).toEqual({
      name: 'beamhop_data',
      region: 'fra',
      size_gb: 1,
      encrypted: true,
    });
    const m = api.calls('POST', '/apps/beamhop-reviewer/machines')[0]!.body;
    expect(m.name).toBe('beamhop-reviewer');
    expect(m.region).toBe('fra');
    expect(m.config.image).toBe('ghcr.io/beamhop/agent:1.2.3');
    expect(m.config.guest).toEqual(FLY_SIZES.find((s) => s.id === 'shared-cpu-1x-1gb')!.guest);
    expect(m.config.restart).toEqual({ policy: 'always' });
    expect(m.config.services).toBeUndefined();
    expect(m.config.mounts).toEqual([{ volume: 'vol_4y5gkog8n7rrxl1r', path: '/home/beamhop/.beamhop' }]);
    expect(m.config.env).toMatchObject({
      BEAMHOP_OWNER_NPUB: OWNER_NPUB,
      BEAMHOP_PROVISIONING_PUBKEY: PROVISIONING_PUBKEY,
      BEAMHOP_AWAIT_PROVISIONING: '1',
      BEAMHOP_HARNESS_PACKAGES: '@anthropic-ai/claude-code @openai/codex',
    });
    expect(JSON.stringify(m)).not.toContain('fm2_');
    expect((await state.get('fly:reviewer'))!.resources).toMatchObject({
      app: 'beamhop-reviewer',
      machineId: '3d8d9e1fe12389',
    });
  });

  it('is idempotent and completes a half-created app', async () => {
    apps.add('beamhop-reviewer');
    volumes.push({ id: 'vol_existing', name: 'beamhop_data', region: 'fra' });
    const d = make();
    await d.apply(spec('fly'));
    expect(api.calls('POST', '/apps')).toHaveLength(0);
    expect(api.calls('POST', '/apps/beamhop-reviewer/volumes')).toHaveLength(0);
    expect(api.calls('POST', '/apps/beamhop-reviewer/machines')[0]!.body.config.mounts[0].volume).toBe(
      'vol_existing',
    );
    await d.apply(spec('fly'));
    expect(api.calls('POST', '/apps/beamhop-reviewer/machines')).toHaveLength(1);
  });

  it('uses a custom image and plain Bearer tokens', async () => {
    await make({ secrets: memorySecrets({ 'deploy.fly.token': 'plain-fly-token-123' }) }).apply(
      spec('fly', { image: 'ghcr.io/beamhop/agent@sha256:abc123' }),
    );
    expect(api.requests[0]!.headers.authorization).toBe('Bearer plain-fly-token-123');
    expect(api.calls('POST', '/apps/beamhop-reviewer/machines')[0]!.body.config.image).toBe(
      'ghcr.io/beamhop/agent@sha256:abc123',
    );
    await expect(make().apply(spec('fly', { agent: 'x2', image: 'evil image; rm' }))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('reports a taken global app name as conflict', async () => {
    api.on('POST', '/apps', { status: 422, body: { error: 'Name has already been taken' } });
    await expect(make().apply(spec('fly'))).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('already been taken'),
    });
  });

  it('maps 401 and retries 429', async () => {
    api.on('GET', '/apps/:app', { status: 401, body: { error: 'unauthorized' } });
    await expect(make().status('fly:reviewer')).rejects.toMatchObject({ code: 'unauthorized' });
    api.seq('GET', '/apps/:app', [
      { status: 429, body: { error: 'rate limited' }, headers: { 'retry-after': '1' } },
      { status: 404, body: { error: 'Not Found' } },
    ]);
    await expect(make().status('fly:reviewer')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('status maps machine state; destroy force-deletes machines then the app', async () => {
    const d = make();
    await d.apply(spec('fly'));
    machines[0].state = 'started';
    expect((await d.status('fly:reviewer')).status).toBe('running');
    machines[0].state = 'stopped';
    expect((await d.status('fly:reviewer')).status).toBe('stopped');
    await d.destroy('fly:reviewer');
    const del = api.calls('DELETE', '/apps/beamhop-reviewer/machines/3d8d9e1fe12389')[0]!;
    expect(del.query.get('force')).toBe('true');
    expect(api.calls('DELETE', '/apps/beamhop-reviewer')).toHaveLength(1);
    await d.destroy('fly:reviewer'); // already gone
    expect(api.calls('DELETE', '/apps/beamhop-reviewer')).toHaveLength(1);
  });
});
