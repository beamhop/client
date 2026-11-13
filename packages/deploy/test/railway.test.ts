import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DeployState, RAILWAY_RATES, RailwayDeployer } from '../src/index.ts';
import {
  FakeApi,
  type FakeResponse,
  memorySecrets,
  noSleep,
  OWNER_NPUB,
  provisioning,
  spec,
  tmpState,
} from './helpers.ts';

const TOKEN = '6f1c2a90-railway-test-token-0000';

interface Project {
  id: string;
  name: string;
  createdAt: string;
  environments: { edges: { node: { id: string; name: string } }[] };
  services: { edges: { node: { id: string; name: string } }[] };
  volumes: { edges: { node: { id: string; name: string } }[] };
}

describe('RailwayDeployer', () => {
  let api: FakeApi;
  let state: DeployState;
  let projects: Project[];
  let latest: { id: string; status: string; createdAt: string } | null;
  // biome-ignore lint/suspicious/noExplicitAny: recorded GraphQL calls
  let ops: { op: string; variables: any }[];
  let override: ((op: string) => FakeResponse | undefined) | undefined;

  const make = (extra: Partial<ConstructorParameters<typeof RailwayDeployer>[0]> = {}) =>
    new RailwayDeployer({
      secrets: memorySecrets({ 'deploy.railway.token': TOKEN }),
      provisioning: () => provisioning(),
      state,
      baseUrl: api.baseUrl,
      sleep: noSleep,
      ...extra,
    });

  beforeEach(async () => {
    api = new FakeApi();
    projects = [];
    latest = null;
    ops = [];
    override = undefined;
    api.on('POST', '/graphql/v2', (r) => {
      const op = /^(?:query|mutation) (\w+)/.exec(r.body.query)?.[1] ?? '?';
      ops.push({ op, variables: r.body.variables });
      const o = override?.(op);
      if (o) return o;
      const v = r.body.variables;
      switch (op) {
        case 'projects':
          return { body: { data: { projects: { edges: projects.map((node) => ({ node })) } } } };
        case 'project':
          return { body: { data: { project: projects.find((p) => p.id === v.id) } } };
        case 'projectCreate': {
          const p: Project = {
            id: 'prj-1',
            name: v.input.name,
            createdAt: '2026-11-13T00:00:00Z',
            environments: { edges: [{ node: { id: 'env-prod', name: 'production' } }] },
            services: { edges: [] },
            volumes: { edges: [] },
          };
          projects.push(p);
          return { body: { data: { projectCreate: { id: p.id, name: p.name } } } };
        }
        case 'serviceCreate': {
          projects[0]!.services.edges.push({ node: { id: 'svc-1', name: v.input.name } });
          return { body: { data: { serviceCreate: { id: 'svc-1', name: v.input.name } } } };
        }
        case 'variableCollectionUpsert':
          return { body: { data: { variableCollectionUpsert: true } } };
        case 'volumeCreate':
          projects[0]!.volumes.edges.push({ node: { id: 'vol-1', name: 'beamhop-data' } });
          return { body: { data: { volumeCreate: { id: 'vol-1', name: 'beamhop-data' } } } };
        case 'serviceInstanceUpdate':
          return { body: { data: { serviceInstanceUpdate: true } } };
        case 'serviceInstanceDeployV2':
          latest = { id: 'dep-1', status: 'BUILDING', createdAt: '2026-11-13T00:00:05Z' };
          return { body: { data: { serviceInstanceDeployV2: 'dep-1' } } };
        case 'serviceInstance':
          return {
            body: {
              data: {
                serviceInstance: { id: 'si-1', region: 'europe-west4-drams3a', latestDeployment: latest },
              },
            },
          };
        case 'deploymentLogs':
          return {
            body: {
              data: {
                deploymentLogs: [
                  {
                    timestamp: '2026-11-13T00:00:06Z',
                    message: 'beamhopd awaiting provisioning',
                    severity: 'info',
                  },
                ],
              },
            },
          };
        case 'projectDelete':
          projects = [];
          return { body: { data: { projectDelete: true } } };
      }
      return { body: { errors: [{ message: `unknown op ${op}` }] } };
    });
    await api.start();
    state = await tmpState();
  });
  afterEach(() => api.close());

  it('estimates usage-based cost and says so', async () => {
    const plan = await make().plan(spec('railway'));
    const expected = 0.25 * RAILWAY_RATES.vcpuMonth + 1 * RAILWAY_RATES.gbRamMonth + 0.15 + 5 * 0.05;
    expect(plan.monthlyCostUsd).toBe(Math.round(expected * 100) / 100); // 15.40
    expect(plan.monthlyCostUsd).toBe(15.4);
    expect(plan.warnings.join(' ')).toMatch(/usage-based: this is an estimate/);
    expect(plan.warnings.join(' ')).toMatch(/container boundary \+ broker egress proxy/);
    const sizes = await make().sizes();
    expect(sizes.map((s) => s.monthlyUsd)).toEqual([15.4, 30.4, 60.4]);
    const heavy = await make({ egressGbPerMonth: 100, volumeGb: 10 }).plan(
      spec('railway', { size: 'usage-large' }),
    );
    expect(heavy.monthlyCostUsd).toBe(20 + 40 + 1.5 + 5);
  });

  it('apply runs projectCreate → serviceCreate(image) → variables → volume → region → deploy', async () => {
    const dep = await make({ workspaceId: 'ws-1' }).apply(spec('railway'));
    expect(dep).toMatchObject({
      id: 'railway:reviewer',
      status: 'provisioning',
      region: 'europe-west4-drams3a',
    });
    expect(ops.map((o) => o.op)).toEqual([
      'projects', // idempotency lookup
      'projects', // create() re-checks before creating
      'projectCreate',
      'project',
      'serviceCreate',
      'variableCollectionUpsert',
      'volumeCreate',
      'serviceInstanceUpdate',
      'serviceInstanceDeployV2',
    ]);
    const req = api.calls('POST', '/graphql/v2')[0]!;
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['content-type']).toBe('application/json');

    const by = (op: string) => ops.find((o) => o.op === op)!.variables;
    expect(by('projectCreate').input).toMatchObject({
      name: 'beamhop-reviewer',
      isPublic: false,
      workspaceId: 'ws-1',
    });
    expect(by('serviceCreate').input).toEqual({
      projectId: 'prj-1',
      environmentId: 'env-prod',
      name: 'beamhop-reviewer',
      source: { image: 'ghcr.io/beamhop/agent:1.2.3' },
    });
    const vars = by('variableCollectionUpsert').input;
    expect(vars).toMatchObject({
      projectId: 'prj-1',
      environmentId: 'env-prod',
      serviceId: 'svc-1',
      skipDeploys: true,
    });
    expect(vars.variables.BEAMHOP_OWNER_NPUB).toBe(OWNER_NPUB);
    expect(JSON.stringify(vars)).not.toContain(TOKEN);
    expect(by('volumeCreate').input.mountPath).toBe('/home/beamhop/.beamhop');
    expect(by('serviceInstanceUpdate').input).toEqual({
      region: 'europe-west4-drams3a',
      numReplicas: 1,
      restartPolicyType: 'ALWAYS',
    });
    expect((await state.get('railway:reviewer'))!.resources).toMatchObject({
      projectId: 'prj-1',
      serviceId: 'svc-1',
      deploymentId: 'dep-1',
    });
  });

  it('is idempotent and resumes a half-created project', async () => {
    const d = make();
    await d.apply(spec('railway'));
    const before = ops.length;
    await d.apply(spec('railway'));
    expect(ops.slice(before).map((o) => o.op)).toEqual(['projects', 'serviceInstance']);

    // project + service exist but were never deployed
    latest = null;
    ops = [];
    await d.apply(spec('railway'));
    const names = ops.map((o) => o.op);
    expect(names).not.toContain('projectCreate');
    expect(names).not.toContain('serviceCreate');
    expect(names).not.toContain('volumeCreate');
    expect(names).toContain('serviceInstanceDeployV2');
  });

  it('status and logs', async () => {
    const d = make();
    await d.apply(spec('railway'));
    latest = { id: 'dep-1', status: 'SUCCESS', createdAt: 'x' };
    expect((await d.status('railway:reviewer')).status).toBe('running');
    latest = { id: 'dep-1', status: 'CRASHED', createdAt: 'x' };
    expect((await d.status('railway:reviewer')).status).toBe('error');
    const lines: string[] = [];
    for await (const l of d.logs('railway:reviewer')) lines.push(l);
    expect(lines).toEqual(['2026-11-13T00:00:06Z info beamhopd awaiting provisioning']);
    expect(ops.find((o) => o.op === 'deploymentLogs')!.variables).toEqual({
      deploymentId: 'dep-1',
      limit: 200,
    });
  });

  it('destroy deletes the project; idempotent', async () => {
    const d = make();
    await d.apply(spec('railway'));
    await d.destroy('railway:reviewer');
    expect(ops.filter((o) => o.op === 'projectDelete')).toEqual([
      { op: 'projectDelete', variables: { id: 'prj-1' } },
    ]);
    await d.destroy('railway:reviewer');
    expect(ops.filter((o) => o.op === 'projectDelete')).toHaveLength(1);
    expect((await d.status('railway:reviewer')).status).toBe('destroyed');
  });

  it('maps GraphQL "Not Authorized" (HTTP 200) to unauthorized and other errors to invalid_input', async () => {
    override = (op) =>
      op === 'projects' ? { body: { errors: [{ message: 'Not Authorized' }] } } : undefined;
    await expect(make().plan(spec('railway'))).rejects.toMatchObject({ code: 'unauthorized' });
    override = (op) =>
      op === 'serviceCreate' ? { body: { errors: [{ message: 'Invalid image reference' }] } } : undefined;
    await expect(make().apply(spec('railway'))).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('Invalid image reference'),
    });
  });

  it('retries HTTP 429 honouring Retry-After, then fails with rate_limited', async () => {
    const sleep = vi.fn(noSleep);
    let n = 0;
    override = () =>
      n++ < 1
        ? { status: 429, body: { message: 'rate limited' }, headers: { 'retry-after': '3' } }
        : undefined;
    await make({ sleep }).plan(spec('railway'));
    expect(sleep).toHaveBeenCalledWith(3000);

    override = () => ({ status: 429, body: { message: 'rate limited' } });
    await expect(make({ maxRetries: 1 }).plan(spec('railway'))).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('HTTP 401 is unauthorized and never echoes the token', async () => {
    override = () => ({ status: 401, body: { errors: [{ message: `bad token ${TOKEN}` }] } });
    const err = await make()
      .plan(spec('railway'))
      .catch((e) => e);
    expect(err.code).toBe('unauthorized');
    expect(err.message).not.toContain(TOKEN);
  });
});
