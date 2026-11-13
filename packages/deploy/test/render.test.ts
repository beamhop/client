import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DeployState, RenderDeployer } from '../src/index.ts';
import { FakeApi, memorySecrets, noSleep, OWNER_NPUB, provisioning, spec, tmpState } from './helpers.ts';

const TOKEN = 'rnd_testtokenAAAAAAAAAAAAAAAAAAAA';

describe('RenderDeployer', () => {
  let api: FakeApi;
  let state: DeployState;
  // biome-ignore lint/suspicious/noExplicitAny: fake records
  let services: any[];
  let deployStatus: string;

  const make = (extra: Partial<ConstructorParameters<typeof RenderDeployer>[0]> = {}) =>
    new RenderDeployer({
      secrets: memorySecrets({ 'deploy.render.token': TOKEN }),
      provisioning: () => provisioning(),
      state,
      baseUrl: api.baseUrl,
      sleep: noSleep,
      ...extra,
    });

  beforeEach(async () => {
    api = new FakeApi();
    services = [];
    deployStatus = 'build_in_progress';
    api
      .on('GET', '/owners', {
        body: [{ owner: { id: 'tea-owner1', name: 'me', type: 'user' }, cursor: 'c1' }],
      })
      .on('GET', '/services', (r) => ({
        body: services
          .filter((s) => s.name === r.query.get('name') && s.type === r.query.get('type'))
          .map((service) => ({ service, cursor: 'x' })),
      }))
      .on('POST', '/services', (r) => {
        const service = {
          id: 'srv-abc123',
          name: r.body.name,
          type: r.body.type,
          suspended: 'not_suspended',
          createdAt: '2026-11-13T00:00:00Z',
          serviceDetails: { plan: r.body.serviceDetails.plan, region: r.body.serviceDetails.region },
        };
        services.push(service);
        return { status: 201, body: { service, deployId: 'dep-1' } };
      })
      .on('GET', '/services/:id/deploys', () => ({
        body: [
          { deploy: { id: 'dep-1', status: deployStatus, createdAt: '2026-11-13T00:00:01Z' }, cursor: 'x' },
        ],
      }))
      .on('POST', '/services/:id/suspend', () => {
        services[0].suspended = 'suspended';
        return { status: 202 };
      })
      .on('POST', '/services/:id/resume', () => {
        services[0].suspended = 'not_suspended';
        return { status: 202 };
      })
      .on('DELETE', '/services/:id', () => {
        services = [];
        return { status: 204 };
      })
      .on('GET', '/logs', {
        body: {
          logs: [
            { timestamp: '2026-11-13T00:00:02Z', message: 'second' },
            { timestamp: '2026-11-13T00:00:01Z', message: 'first' },
          ],
          hasMore: false,
        },
      });
    await api.start();
    state = await tmpState();
  });
  afterEach(() => api.close());

  it('plan: plan price + disk, PaaS sandbox warning', async () => {
    const plan = await make().plan(spec('render'));
    expect(plan.monthlyCostUsd).toBe(25.25);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.resource).toBe('background_worker/beamhop-reviewer');
    expect(plan.warnings[0]).toMatch(
      /srt may not have user namespaces here; container boundary \+ broker egress proxy apply/,
    );
    const big = await make({ diskGb: 10 }).plan(spec('render', { size: 'pro', region: 'oregon' }));
    expect(big.monthlyCostUsd).toBe(87.5);
    const small = await make().plan(spec('render', { size: 'starter' }));
    expect(small.warnings.join(' ')).toMatch(/too small/);
  });

  it('apply creates a background worker from the image with non-secret env and a disk', async () => {
    const dep = await make().apply(spec('render'));
    expect(dep).toMatchObject({
      id: 'render:reviewer',
      status: 'provisioning',
      region: 'frankfurt',
      size: 'standard',
    });
    const req = api.calls('POST', '/services')[0]!;
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.body).toMatchObject({
      type: 'background_worker',
      name: 'beamhop-reviewer',
      ownerId: 'tea-owner1',
      image: { ownerId: 'tea-owner1', imagePath: 'ghcr.io/beamhop/agent:1.2.3' },
      serviceDetails: {
        runtime: 'image',
        plan: 'standard',
        region: 'frankfurt',
        numInstances: 1,
        disk: { name: 'beamhop-data', mountPath: '/home/beamhop/.beamhop', sizeGB: 1 },
      },
    });
    expect(req.body.envVars).toContainEqual({ key: 'BEAMHOP_OWNER_NPUB', value: OWNER_NPUB });
    for (const e of req.body.envVars) expect(e.generateValue).toBeUndefined();
    expect(JSON.stringify(req.body)).not.toContain(TOKEN);
    expect((await state.get('render:reviewer'))!.resources).toMatchObject({
      serviceId: 'srv-abc123',
      ownerId: 'tea-owner1',
    });
  });

  it('uses an explicit ownerId and is idempotent', async () => {
    const d = make({ ownerId: 'tea-team' });
    await d.apply(spec('render'));
    await d.apply(spec('render'));
    expect(api.calls('GET', '/owners')).toHaveLength(0);
    expect(api.calls('POST', '/services')).toHaveLength(1);
    expect(api.calls('GET', '/services')[0]!.query.get('ownerId')).toBe('tea-team');
  });

  it('status follows deploys and suspension; suspend/resume/deploys/logs', async () => {
    const d = make();
    await d.apply(spec('render'));
    expect((await d.status('render:reviewer')).status).toBe('provisioning');
    deployStatus = 'live';
    expect((await d.status('render:reviewer')).status).toBe('running');
    deployStatus = 'build_failed';
    expect((await d.status('render:reviewer')).status).toBe('error');
    await d.suspend('render:reviewer');
    expect(api.calls('POST', '/services/srv-abc123/suspend')).toHaveLength(1);
    expect((await d.status('render:reviewer')).status).toBe('stopped');
    await d.resume('render:reviewer');
    expect(api.calls('POST', '/services/srv-abc123/resume')).toHaveLength(1);
    expect((await d.deploys('render:reviewer'))[0]!.id).toBe('dep-1');

    const lines: string[] = [];
    for await (const l of d.logs('render:reviewer')) lines.push(l);
    expect(lines).toEqual(['2026-11-13T00:00:01Z first', '2026-11-13T00:00:02Z second']);
    const q = api.calls('GET', '/logs')[0]!.query;
    expect(q.get('resource')).toBe('srv-abc123');
    expect(q.get('ownerId')).toBe('tea-owner1');
  });

  it('destroy deletes the service; idempotent', async () => {
    const d = make();
    await d.apply(spec('render'));
    await d.destroy('render:reviewer');
    expect(api.calls('DELETE', '/services/srv-abc123')).toHaveLength(1);
    await d.destroy('render:reviewer');
    expect(api.calls('DELETE')).toHaveLength(1);
    await expect(d.suspend('render:reviewer')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('maps 401, 422 and 429', async () => {
    api.on('GET', '/owners', { status: 401, body: { message: 'unauthorized' } });
    await expect(make().plan(spec('render'))).rejects.toMatchObject({ code: 'unauthorized' });
    api.on('GET', '/owners', { body: [{ owner: { id: 'tea-owner1' } }] });
    api.on('POST', '/services', { status: 400, body: { message: 'invalid plan for background worker' } });
    await expect(make().apply(spec('render'))).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('invalid plan'),
    });
    api.on('GET', '/services', { status: 429, body: { message: 'rate limit exceeded' } });
    await expect(make({ maxRetries: 1 }).status('render:reviewer')).rejects.toMatchObject({
      code: 'rate_limited',
    });
    expect(api.calls('GET', '/services').length).toBeGreaterThanOrEqual(2);
  });
});
