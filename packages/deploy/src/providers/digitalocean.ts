import { BeamhopError, type Deployment } from '@beamhop/core';
import { renderCloudInit } from '../cloud-init.ts';
import {
  BaseDeployer,
  type DeployerOptions,
  deploymentId,
  type ExistingDeployment,
  noLogApi,
  type PlanContext,
  type ResolvedProvisioning,
  resourceName,
} from '../common.ts';
import type { HttpClient } from '../http.ts';
import type { DeployRecord } from '../state.ts';

/**
 * DigitalOcean deployer (VPS). API reference: https://docs.digitalocean.com/reference/api/digitalocean/
 *
 *  - GET    /v2/sizes                 slug, vcpus, memory (MB), price_monthly (USD), regions
 *  - GET    /v2/regions               slug, name, available
 *  - GET    /v2/droplets?name=        idempotency lookup by name
 *  - GET    /v2/firewalls             list (filtered client-side by name)
 *  - POST   /v2/firewalls             { name, inbound_rules: [], outbound_rules, tags } — applies by tag
 *  - POST   /v2/droplets              { name, region, size, image, user_data, tags }
 *  - DELETE /v2/droplets/{id}, DELETE /v2/firewalls/{id}
 *
 * Auth: `Authorization: Bearer <token>`. Rate limit 5000 req/h + 250/min; 429 with ratelimit-reset.
 */

export interface DigitalOceanOptions extends DeployerOptions {
  /** OS image slug. Default ubuntu-24-04-x64. */
  image?: string;
}

interface DOSize {
  slug: string;
  memory: number;
  vcpus: number;
  disk: number;
  price_monthly: number;
  available: boolean;
  regions: string[];
  description?: string;
}
interface DODroplet {
  id: number;
  name: string;
  status: string;
  created_at: string;
  size_slug: string;
  region?: { slug: string };
  networks?: { v4?: { ip_address: string; type: string }[]; v6?: { ip_address: string; type: string }[] };
  tags?: string[];
}
interface DOFirewall {
  id: string;
  name: string;
}

const STATUS: Record<string, Deployment['status']> = {
  new: 'provisioning',
  active: 'running',
  off: 'stopped',
  archive: 'destroyed',
};

const ALL = { addresses: ['0.0.0.0/0', '::/0'] };

export const agentTag = (agent: string): string => `beamhop-agent-${agent}`;

export class DigitalOceanDeployer extends BaseDeployer {
  readonly id = 'digitalocean';
  readonly displayName = 'DigitalOcean';
  readonly kind = 'vps' as const;
  protected readonly defaultBaseUrl = 'https://api.digitalocean.com/v2';
  protected readonly defaultRegion = 'fra1';
  protected readonly defaultSize = 's-1vcpu-2gb';
  private sizeCache?: DOSize[];

  constructor(protected override readonly opts: DigitalOceanOptions) {
    super(opts);
  }

  private async sizeList(): Promise<DOSize[]> {
    if (!this.sizeCache) {
      const http = await this.http();
      const r = await http.get<{ sizes: DOSize[] }>('/sizes', { query: { per_page: 200 } });
      this.sizeCache = r.sizes.filter((s) => s.available);
    }
    return this.sizeCache;
  }

  async sizes() {
    return (await this.sizeList()).map((s) => ({
      id: s.slug,
      label: `${s.slug} — ${s.vcpus} vCPU, ${s.memory / 1024} GB RAM, ${s.disk} GB disk`,
      monthlyUsd: s.price_monthly,
    }));
  }

  async regions() {
    const http = await this.http();
    const r = await http.get<{ regions: { slug: string; name: string; available: boolean }[] }>('/regions', {
      query: { per_page: 200 },
    });
    return r.regions.filter((x) => x.available).map((x) => ({ id: x.slug, label: `${x.name} (${x.slug})` }));
  }

  private toDeployment(agent: string, d: DODroplet): Deployment {
    const pub = d.networks?.v4?.find((n) => n.type === 'public')?.ip_address;
    return {
      id: deploymentId(this.id, agent),
      provider: this.id,
      agent,
      status: STATUS[d.status] ?? 'error',
      region: d.region?.slug,
      size: d.size_slug,
      createdAt: d.created_at,
      address: pub ?? d.networks?.v6?.find((n) => n.type === 'public')?.ip_address,
    };
  }

  private async findFirewall(http: HttpClient, name: string): Promise<DOFirewall | undefined> {
    const r = await http.get<{ firewalls: DOFirewall[] }>('/firewalls', { query: { per_page: 200 } });
    return r.firewalls.find((f) => f.name === name);
  }

  protected async find(agent: string): Promise<ExistingDeployment | undefined> {
    const http = await this.http();
    const name = resourceName(agent);
    const r = await http.get<{ droplets: DODroplet[] }>('/droplets', { query: { name } });
    const d = r.droplets.find((x) => x.name === name);
    if (!d) return undefined;
    const fw = await this.findFirewall(http, name);
    return {
      deployment: this.toDeployment(agent, d),
      resources: { dropletId: String(d.id), ...(fw ? { firewallId: fw.id } : {}) },
    };
  }

  protected async planCreate({ spec }: PlanContext) {
    const size = (await this.sizeList()).find((s) => s.slug === spec.size);
    if (size?.regions.length && !size.regions.includes(spec.region)) {
      throw new BeamhopError('invalid_input', `size ${spec.size} is not available in ${spec.region}`);
    }
    const name = resourceName(spec.agent);
    return {
      actions: [
        {
          op: 'create' as const,
          resource: `firewall/${name}`,
          detail: `Cloud firewall on tag ${agentTag(spec.agent)}: no inbound rules, all outbound allowed`,
        },
        {
          op: 'create' as const,
          resource: `droplet/${name}`,
          detail: `${spec.size} in ${spec.region}, ${this.opts.image ?? 'ubuntu-24-04-x64'}, cloud-init installs beamhop + ${spec.harnesses.join(', ')}`,
        },
      ],
      monthlyCostUsd: size?.price_monthly ?? 0,
      warnings: [
        'DigitalOcean may email a root password for droplets created without SSH keys; root and password login are disabled by cloud-init.',
        'No inbound ports are open. Logs and control go over Nostr.',
      ],
    };
  }

  protected async create(
    spec: PlanContext['spec'],
    prov: ResolvedProvisioning,
    _pkgs: string[],
  ): Promise<ExistingDeployment> {
    const http = await this.http();
    const name = resourceName(spec.agent);
    const tags = ['beamhop', agentTag(spec.agent)];
    const ssh = prov.sshAuthorizedKeys.length > 0;

    let fw = await this.findFirewall(http, name);
    if (!fw) {
      const r = await http.post<{ firewall: DOFirewall }>('/firewalls', {
        name,
        inbound_rules: ssh ? [{ protocol: 'tcp', ports: '22', sources: ALL }] : [],
        outbound_rules: [
          { protocol: 'tcp', ports: 'all', destinations: ALL },
          { protocol: 'udp', ports: 'all', destinations: ALL },
          { protocol: 'icmp', destinations: ALL },
        ],
        tags: [agentTag(spec.agent)],
      });
      fw = r.firewall;
    }

    const userData = renderCloudInit({
      agent: spec.agent,
      harnesses: spec.harnesses,
      beamhopVersion: prov.beamhopVersion,
      ownerNpub: prov.ownerNpub,
      daemonNsecRef: prov.daemonNsecRef,
      provisioningPubkey: prov.provisioningPubkey,
      ...(prov.provisioningToken ? { provisioningToken: prov.provisioningToken } : {}),
      sshAuthorizedKeys: prov.sshAuthorizedKeys,
      harnessPackages: this.opts.harnessPackages,
      provider: this.id,
    });

    const r = await http.post<{ droplet: DODroplet }>('/droplets', {
      name,
      region: spec.region,
      size: spec.size,
      image: this.opts.image ?? 'ubuntu-24-04-x64',
      user_data: userData,
      tags,
      ipv6: true,
      monitoring: false,
      backups: false,
    });
    return {
      deployment: this.toDeployment(spec.agent, r.droplet),
      resources: { dropletId: String(r.droplet.id), firewallId: fw.id },
    };
  }

  protected async remove(agent: string, rec: DeployRecord | undefined): Promise<void> {
    const http = await this.http();
    const found = await this.find(agent);
    const dropletId = found?.resources.dropletId ?? rec?.resources.dropletId;
    if (dropletId) await http.delete(`/droplets/${dropletId}`, { allow404: true });
    const fw = await this.findFirewall(http, resourceName(agent));
    if (fw) await http.delete(`/firewalls/${fw.id}`, { allow404: true });
  }

  logs(id: string): AsyncIterable<string> {
    const agent = this.agentFromId(id);
    return noLogApi(
      this.displayName,
      `Use \`beamhop logs --agent ${agent}\` (journal of beamhopd.service, streamed over the Nostr control channel); with SSH opted in: \`ssh beamhop@<ip> journalctl -u beamhopd -f\`.`,
    );
  }
}
