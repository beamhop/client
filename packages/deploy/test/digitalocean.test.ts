import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DeployState, DigitalOceanDeployer } from '../src/index.ts';
import { FakeApi, memorySecrets, noSleep, OWNER_NPUB, provisioning, spec, tmpState } from './helpers.ts';

const TOKEN = ['dop', 'v1', '0123456789abcdef'.repeat(4)].join('_'); // built at runtime so secret scanners don't flag a fake token

const sizes = {
  sizes: [
    {
      slug: 's-1vcpu-1gb',
      memory: 1024,
      vcpus: 1,
      disk: 25,
      price_monthly: 6,
      available: true,
      regions: ['fra1', 'nyc3'],
    },
    {
      slug: 's-1vcpu-2gb',
      memory: 2048,
      vcpus: 1,
      disk: 50,
      price_monthly: 12,
      available: true,
      regions: ['fra1', 'nyc3'],
    },
    {
      slug: 's-2vcpu-4gb',
      memory: 4096,
      vcpus: 2,
      disk: 80,
      price_monthly: 24,
      available: true,
      regions: ['nyc3'],
    },
    { slug: 'gone', memory: 512, vcpus: 1, disk: 10, price_monthly: 4, available: false, regions: [] },
  ],
};

const droplet = (status = 'new') => ({
  id: 3164444,
  name: 'beamhop-reviewer',
  status,
  created_at: '2026-11-13T00:00:00Z',
  size_slug: 's-1vcpu-2gb',
  region: { slug: 'fra1' },
  networks: {
    v4: [
      { ip_address: '10.0.0.2', type: 'private' },
      { ip_address: '198.51.100.4', type: 'public' },
    ],
  },
  tags: ['beamhop', 'beamhop-agent-reviewer'],
});

describe('DigitalOceanDeployer', () => {
  let api: FakeApi;
  let state: DeployState;
  let droplets: ReturnType<typeof droplet>[];
  let firewalls: { id: string; name: string }[];

  const make = (extra: Partial<ConstructorParameters<typeof DigitalOceanDeployer>[0]> = {}) =>
    new DigitalOceanDeployer({
      secrets: memorySecrets({ 'deploy.digitalocean.token': TOKEN }),
      provisioning: () => provisioning(),
      state,
      baseUrl: api.baseUrl,
      sleep: noSleep,
      ...extra,
    });

  beforeEach(async () => {
    api = new FakeApi();
    droplets = [];
    firewalls = [];
    api
      .on('GET', '/sizes', { body: sizes })
      .on('GET', '/regions', {
        body: {
          regions: [
            { slug: 'fra1', name: 'Frankfurt 1', available: true },
            { slug: 'nyc3', name: 'New York 3', available: true },
            { slug: 'old1', name: 'Old', available: false },
          ],
        },
      })
      .on('GET', '/droplets', (r) => ({
        body: { droplets: droplets.filter((d) => d.name === r.query.get('name')) },
      }))
      .on('GET', '/firewalls', () => ({ body: { firewalls } }))
      .on('POST', '/firewalls', (r) => {
        const fw = { id: 'fb6045f1-cf1d-4ca3-bfac-18832663025b', name: r.body.name };
        firewalls.push(fw);
        return { status: 202, body: { firewall: fw } };
      })
      .on('POST', '/droplets', () => {
        const d = droplet();
        droplets.push(d);
        return { status: 202, body: { droplet: d, links: {} } };
      })
      .on('DELETE', '/droplets/:id', () => {
        droplets = [];
        return { status: 204 };
      })
      .on('DELETE', '/firewalls/:id', () => {
        firewalls = [];
        return { status: 204 };
      });
    await api.start();
    state = await tmpState();
  });
  afterEach(() => api.close());

  it('lists available sizes (price_monthly) and regions', async () => {
    const d = make();
    expect((await d.sizes()).map((s) => [s.id, s.monthlyUsd])).toEqual([
      ['s-1vcpu-1gb', 6],
      ['s-1vcpu-2gb', 12],
      ['s-2vcpu-4gb', 24],
    ]);
    expect((await d.regions()).map((r) => r.id)).toEqual(['fra1', 'nyc3']);
    expect(api.calls('GET', '/sizes')[0]!.query.get('per_page')).toBe('200');
    expect(api.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('plans with the size price and rejects sizes not offered in the region', async () => {
    const plan = await make().plan(spec('digitalocean'));
    expect(plan.monthlyCostUsd).toBe(12);
    expect(plan.actions.map((a) => a.resource)).toEqual([
      'firewall/beamhop-reviewer',
      'droplet/beamhop-reviewer',
    ]);
    await expect(make().plan(spec('digitalocean', { size: 's-2vcpu-4gb' }))).rejects.toThrow(
      /not available in fra1/,
    );
  });

  it('apply creates a tag-scoped cloud firewall without inbound rules, then the droplet', async () => {
    const dep = await make().apply(spec('digitalocean', { harnesses: ['claude', 'gemini'] }));
    expect(dep).toMatchObject({
      id: 'digitalocean:reviewer',
      status: 'provisioning',
      region: 'fra1',
      size: 's-1vcpu-2gb',
      address: '198.51.100.4',
    });
    const fw = api.calls('POST', '/firewalls')[0]!.body;
    expect(fw.name).toBe('beamhop-reviewer');
    expect(fw.inbound_rules).toEqual([]);
    expect(fw.tags).toEqual(['beamhop-agent-reviewer']);
    expect(fw.outbound_rules).toContainEqual({
      protocol: 'tcp',
      ports: 'all',
      destinations: { addresses: ['0.0.0.0/0', '::/0'] },
    });

    const body = api.calls('POST', '/droplets')[0]!.body;
    expect(body).toMatchObject({
      name: 'beamhop-reviewer',
      region: 'fra1',
      size: 's-1vcpu-2gb',
      image: 'ubuntu-24-04-x64',
      tags: ['beamhop', 'beamhop-agent-reviewer'],
    });
    expect(body.ssh_keys).toBeUndefined();
    expect(body.user_data).toContain('@google/gemini-cli');
    expect(body.user_data).toContain(OWNER_NPUB);
    expect(body.user_data).not.toContain(TOKEN);
    expect(JSON.stringify(api.requests.map((r) => r.body))).not.toContain(TOKEN);
  });

  it('apply is idempotent by droplet name', async () => {
    const d = make();
    await d.apply(spec('digitalocean'));
    const again = await d.apply(spec('digitalocean'));
    expect(again.id).toBe('digitalocean:reviewer');
    expect(api.calls('POST', '/droplets')).toHaveLength(1);
    expect(api.calls('POST', '/firewalls')).toHaveLength(1);
  });

  it('opens 22/tcp only with SSH opt-in', async () => {
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGJ1aWxkZXJrZXlmb3J0ZXN0c29ubHkxMjM0NTY3OA me@laptop';
    await make({ provisioning: () => provisioning({ sshAuthorizedKeys: [key] }) }).apply(
      spec('digitalocean'),
    );
    expect(api.calls('POST', '/firewalls')[0]!.body.inbound_rules).toEqual([
      { protocol: 'tcp', ports: '22', sources: { addresses: ['0.0.0.0/0', '::/0'] } },
    ]);
  });

  it('maps 401 / 422 / 429 errors', async () => {
    api.on('GET', '/sizes', {
      status: 401,
      body: { id: 'Unauthorized', message: 'Unable to authenticate you' },
    });
    await expect(make().sizes()).rejects.toMatchObject({ code: 'unauthorized' });

    api.on('GET', '/sizes', { body: sizes });
    api.on('POST', '/droplets', {
      status: 422,
      body: { id: 'unprocessable_entity', message: 'Region is not available' },
    });
    await expect(make().apply(spec('digitalocean'))).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('Region is not available'),
    });

    const sleep = vi.fn(noSleep);
    const resetAt = Math.floor(Date.now() / 1000) + 5;
    api.seq('GET', '/regions', [
      {
        status: 429,
        body: { id: 'too_many_requests', message: 'API Rate limit exceeded.' },
        headers: { 'ratelimit-reset': String(resetAt) },
      },
      { body: { regions: [{ slug: 'fra1', name: 'Frankfurt 1', available: true }] } },
    ]);
    expect(await make({ sleep }).regions()).toHaveLength(1);
    const waited = sleep.mock.calls[0]![0];
    expect(waited).toBeGreaterThan(3000);
    expect(waited).toBeLessThanOrEqual(6000);
  });

  it('destroy deletes droplet and firewall; status reflects droplet state', async () => {
    const d = make();
    await d.apply(spec('digitalocean'));
    droplets[0]!.status = 'active';
    expect((await d.status('digitalocean:reviewer')).status).toBe('running');
    await d.destroy('digitalocean:reviewer');
    expect(api.calls('DELETE', '/droplets/3164444')).toHaveLength(1);
    expect(api.calls('DELETE', /^\/firewalls\//)).toHaveLength(1);
    expect((await d.status('digitalocean:reviewer')).status).toBe('destroyed');
    await expect(make({ state: await tmpState() }).status('digitalocean:other')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
