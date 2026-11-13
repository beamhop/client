import { readFile, stat } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DeployState, HetznerDeployer } from '../src/index.ts';
import { FakeApi, memorySecrets, noSleep, OWNER_NPUB, provisioning, spec, tmpState } from './helpers.ts';

const TOKEN = 'hz-test-token-0123456789abcdef';

const serverTypes = {
  server_types: [
    {
      id: 1,
      name: 'cx23',
      description: 'CX23',
      cores: 2,
      memory: 4,
      disk: 40,
      architecture: 'x86',
      deprecation: null,
      prices: [
        { location: 'fsn1', price_monthly: { net: '3.4900', gross: '4.1531' } },
        { location: 'hel1', price_monthly: { net: '3.4900', gross: '4.1531' } },
      ],
    },
    {
      id: 2,
      name: 'cx11',
      description: 'old',
      cores: 1,
      memory: 2,
      disk: 20,
      architecture: 'x86',
      deprecation: { announced: '2024-01-01', unavailable_after: '2024-06-01' },
      prices: [{ location: 'fsn1', price_monthly: { net: '1.0000', gross: '1.19' } }],
    },
    {
      id: 3,
      name: 'cax11',
      description: 'arm',
      cores: 2,
      memory: 4,
      disk: 40,
      architecture: 'arm',
      deprecation: null,
      prices: [{ location: 'fsn1', price_monthly: { net: '3.2900', gross: '3.9151' } }],
    },
    {
      id: 4,
      name: 'cpx22',
      description: 'CPX22',
      cores: 2,
      memory: 4,
      disk: 80,
      architecture: 'x86',
      deprecation: null,
      prices: [{ location: 'fsn1', price_monthly: { net: '5.9900', gross: '7.1281' } }],
    },
  ],
};

const pricing = {
  pricing: {
    currency: 'EUR',
    vat_rate: '19.00',
    primary_ips: [
      { type: 'ipv4', prices: [{ location: 'fsn1', price_monthly: { net: '0.5000', gross: '0.5950' } }] },
      { type: 'ipv6', prices: [{ location: 'fsn1', price_monthly: { net: '0.0000', gross: '0.0000' } }] },
    ],
  },
};

const server = (status = 'initializing') => ({
  id: 4242,
  name: 'beamhop-reviewer',
  status,
  created: '2026-11-13T00:00:00+00:00',
  server_type: { name: 'cx23' },
  datacenter: { location: { name: 'fsn1' } },
  public_net: { ipv4: { ip: '203.0.113.7' }, ipv6: { ip: '2001:db8::/64' } },
});

describe('HetznerDeployer', () => {
  let api: FakeApi;
  let state: DeployState;
  let servers: ReturnType<typeof server>[];
  let firewalls: { id: number; name: string }[];

  const make = (extra: Partial<ConstructorParameters<typeof HetznerDeployer>[0]> = {}) =>
    new HetznerDeployer({
      secrets: memorySecrets({ 'deploy.hetzner.token': TOKEN }),
      provisioning: () => provisioning(),
      state,
      baseUrl: api.baseUrl,
      sleep: noSleep,
      ...extra,
    });

  beforeEach(async () => {
    api = new FakeApi();
    servers = [];
    firewalls = [];
    api
      .on('GET', '/server_types', { body: serverTypes })
      .on('GET', '/pricing', { body: pricing })
      .on('GET', '/locations', {
        body: {
          locations: [
            { name: 'fsn1', description: 'Falkenstein DC Park 1', city: 'Falkenstein', country: 'DE' },
            { name: 'hel1', description: 'Helsinki DC Park 1', city: 'Helsinki', country: 'FI' },
          ],
        },
      })
      .on('GET', '/servers', (r) => ({
        body: { servers: servers.filter((s) => s.name === r.query.get('name')) },
      }))
      .on('GET', '/firewalls', (r) => ({
        body: { firewalls: firewalls.filter((f) => f.name === r.query.get('name')) },
      }))
      .on('POST', '/firewalls', (r) => {
        const fw = { id: 77, name: r.body.name };
        firewalls.push(fw);
        return { status: 201, body: { firewall: fw, actions: [] } };
      })
      .on('POST', '/servers', () => {
        const s = server();
        servers.push(s);
        // Hetzner returns a root password when no ssh_keys are passed; it must be discarded.
        return {
          status: 201,
          body: { server: s, action: { id: 1 }, root_password: 'R00tPassw0rdFromHetzner' },
        };
      })
      .on('DELETE', '/servers/:id', () => {
        servers = [];
        return { body: { action: { id: 2 } } };
      })
      .on('DELETE', '/firewalls/:id', () => {
        firewalls = [];
        return { status: 204 };
      });
    await api.start();
    state = await tmpState();
  });
  afterEach(() => api.close());

  it('lists non-deprecated sizes with EUR→USD prices and regions', async () => {
    const d = make({ eurToUsd: 1.1 });
    const sizes = await d.sizes();
    expect(sizes.map((s) => s.id)).toEqual(['cx23', 'cax11', 'cpx22']);
    expect(sizes[0]!.monthlyUsd).toBeCloseTo(3.84, 2);
    expect(await d.regions()).toEqual([
      { id: 'fsn1', label: 'Falkenstein, DE (fsn1)' },
      { id: 'hel1', label: 'Helsinki, FI (hel1)' },
    ]);
    expect(api.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('plans cost = (server net + IPv4 net) × rate and picks the cheapest x86 ≥2 GB by default', async () => {
    const plan = await make({ eurToUsd: 1.1 }).plan(spec('hetzner'));
    expect(plan.provider).toBe('hetzner');
    expect(plan.monthlyCostUsd).toBe(Math.round((3.49 + 0.5) * 1.1 * 100) / 100);
    expect(plan.actions.map((a) => a.resource)).toEqual([
      'firewall/beamhop-reviewer',
      'server/beamhop-reviewer',
    ]);
    expect(plan.actions[1]!.detail).toContain('cx23 in fsn1');
    expect(plan.warnings.join(' ')).toMatch(/EUR/);
    // plan performs no writes
    expect(api.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('rejects unknown sizes/regions and a size not offered in the region', async () => {
    await expect(make().plan(spec('hetzner', { size: 'nope' }))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(make().plan(spec('hetzner', { region: 'mars1' }))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(make().plan(spec('hetzner', { region: 'hel1', size: 'cpx22' }))).rejects.toThrow(
      /not available/,
    );
  });

  it('apply creates a no-inbound firewall and a server with cloud-init user_data', async () => {
    const dep = await make().apply(spec('hetzner'));
    expect(dep).toMatchObject({
      id: 'hetzner:reviewer',
      provider: 'hetzner',
      agent: 'reviewer',
      status: 'provisioning',
      region: 'fsn1',
      size: 'cx23',
      address: '203.0.113.7',
    });

    const [fw] = api.calls('POST', '/firewalls');
    expect(fw!.body).toEqual({
      name: 'beamhop-reviewer',
      labels: { 'managed-by': 'beamhop', 'beamhop-agent': 'reviewer' },
      rules: [],
    });
    expect(fw!.headers['content-type']).toBe('application/json');

    const [srv] = api.calls('POST', '/servers');
    expect(srv!.body).toMatchObject({
      name: 'beamhop-reviewer',
      server_type: 'cx23',
      image: 'ubuntu-24.04',
      location: 'fsn1',
      firewalls: [{ firewall: 77 }],
      labels: { 'managed-by': 'beamhop', 'beamhop-agent': 'reviewer' },
      start_after_create: true,
    });
    expect(srv!.body.ssh_keys).toBeUndefined();
    const ud: string = srv!.body.user_data;
    expect(ud.startsWith('#cloud-config')).toBe(true);
    expect(ud).toContain(OWNER_NPUB);
    expect(ud).toContain('beamhop@1.2.3');
    expect(ud).not.toContain(TOKEN);

    const raw = await readFile(state.file, 'utf8');
    expect(raw).not.toContain('R00tPassw0rd');
    expect(raw).not.toContain(TOKEN);
    const rec = await state.get('hetzner:reviewer');
    expect(rec).toMatchObject({ resources: { serverId: '4242', firewallId: '77' } });
    expect(rec!.monthlyCostUsd).toBeGreaterThan(0);
    if (process.platform !== 'win32') expect((await stat(state.file)).mode & 0o777).toBe(0o600);
  });

  it('apply is idempotent by name', async () => {
    const d = make();
    await d.apply(spec('hetzner'));
    await d.apply(spec('hetzner'));
    expect(api.calls('POST')).toHaveLength(2); // one firewall + one server, not four
    const plan = await d.plan(spec('hetzner'));
    expect(plan.actions).toEqual([]);
    expect(plan.warnings[0]).toMatch(/already exists/);
  });

  it('reuses an existing firewall after a partial failure', async () => {
    firewalls.push({ id: 99, name: 'beamhop-reviewer' });
    await make().apply(spec('hetzner'));
    expect(api.calls('POST', '/firewalls')).toHaveLength(0);
    expect(api.calls('POST', '/servers')[0]!.body.firewalls).toEqual([{ firewall: 99 }]);
  });

  it('opens port 22 only when SSH is opted in', async () => {
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGJ1aWxkZXJrZXlmb3J0ZXN0c29ubHkxMjM0NTY3OA me@laptop';
    await make({ provisioning: () => provisioning({ sshAuthorizedKeys: [key] }) }).apply(spec('hetzner'));
    expect(api.calls('POST', '/firewalls')[0]!.body.rules).toEqual([
      {
        direction: 'in',
        protocol: 'tcp',
        port: '22',
        source_ips: ['0.0.0.0/0', '::/0'],
        description: 'ssh (opt-in)',
      },
    ]);
    expect(api.calls('POST', '/servers')[0]!.body.user_data).toContain(key);
  });

  it('maps 401 to unauthorized without leaking the token', async () => {
    api.on('GET', '/server_types', {
      status: 401,
      body: { error: { code: 'unauthorized', message: `unable to authenticate ${TOKEN}` } },
    });
    const err = await make()
      .sizes()
      .catch((e) => e);
    expect(err.code).toBe('unauthorized');
    expect(err.message).toContain('deploy.hetzner.token');
    expect(err.message).not.toContain(TOKEN);
  });

  it('maps 422 to invalid_input with the provider message', async () => {
    api.on('POST', '/servers', {
      status: 422,
      body: { error: { code: 'invalid_input', message: 'invalid input in field server_type' } },
    });
    await expect(make().apply(spec('hetzner'))).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('invalid input in field server_type'),
      details: expect.objectContaining({ status: 422, providerCode: 'invalid_input' }),
    });
  });

  it('retries 429 using RateLimit-Reset / Retry-After and then succeeds', async () => {
    const sleep = vi.fn(noSleep);
    api.seq('GET', '/server_types', [
      {
        status: 429,
        body: { error: { code: 'rate_limit_exceeded', message: 'limit' } },
        headers: { 'retry-after': '2' },
      },
      { body: serverTypes },
    ]);
    const sizes = await make({ sleep }).sizes();
    expect(sizes).toHaveLength(3);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('gives up with rate_limited after max retries', async () => {
    api.on('GET', '/server_types', {
      status: 429,
      body: { error: { code: 'rate_limit_exceeded', message: 'x' } },
    });
    await expect(make({ maxRetries: 2 }).sizes()).rejects.toMatchObject({ code: 'rate_limited' });
    expect(api.calls('GET', '/server_types')).toHaveLength(3);
  });

  it('does not retry non-idempotent POSTs on 5xx', async () => {
    api.on('POST', '/firewalls', { status: 503, body: { error: { code: 'unavailable', message: 'down' } } });
    await expect(make().apply(spec('hetzner'))).rejects.toMatchObject({ code: 'unavailable' });
    expect(api.calls('POST', '/firewalls')).toHaveLength(1);
  });

  it('enforces the spend cap before creating anything', async () => {
    await expect(make({ maxMonthlyUsd: 1 }).apply(spec('hetzner'))).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
    expect(api.calls('POST')).toHaveLength(0);
    const plan = await make({ maxMonthlyUsd: 1 }).plan(spec('hetzner'));
    expect(plan.warnings.join(' ')).toMatch(/exceeds the deploy cap/);
  });

  it('requires a stored token', async () => {
    await expect(make({ secrets: memorySecrets() }).sizes()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(api.requests).toHaveLength(0);
  });

  it('status maps server states and reports destroyed after deletion', async () => {
    const d = make();
    await d.apply(spec('hetzner'));
    servers[0]!.status = 'running';
    expect((await d.status('hetzner:reviewer')).status).toBe('running');
    servers[0]!.status = 'off';
    expect((await d.status('hetzner:reviewer')).status).toBe('stopped');
    await expect(d.status('fly:reviewer')).rejects.toMatchObject({ code: 'invalid_input' });
    await d.destroy('hetzner:reviewer');
    expect((await d.status('hetzner:reviewer')).status).toBe('destroyed');
  });

  it('destroy deletes the server, waits for the firewall to detach, and is idempotent', async () => {
    const d = make();
    await d.apply(spec('hetzner'));
    let n = 0;
    api.on('DELETE', '/firewalls/:id', () =>
      n++ === 0
        ? { status: 409, body: { error: { code: 'resource_in_use', message: 'firewall still applied' } } }
        : { status: 204 },
    );
    await d.destroy('hetzner:reviewer');
    expect(api.calls('DELETE', '/servers/4242')).toHaveLength(1);
    expect(api.calls('DELETE', '/firewalls/77')).toHaveLength(2);
    expect((await state.get('hetzner:reviewer'))!.status).toBe('destroyed');
    firewalls = [];
    await d.destroy('hetzner:reviewer'); // nothing left: no error
  });

  it('logs explain the control-channel path', async () => {
    const lines: string[] = [];
    for await (const l of make().logs('hetzner:reviewer')) lines.push(l);
    expect(lines.join('\n')).toMatch(/beamhop logs --agent reviewer/);
  });
});
