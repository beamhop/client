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
 * Hetzner Cloud deployer (VPS). API reference: https://docs.hetzner.cloud/
 *
 *  - GET    /v1/server_types        specs + per-location prices (price_monthly.net/gross)
 *  - GET    /v1/pricing             currency (EUR) and primary IPv4 price
 *  - GET    /v1/locations           locations (fsn1, nbg1, hel1, ash, hil, sin)
 *  - GET    /v1/servers?name=       idempotency lookup by name
 *  - POST   /v1/firewalls           { name, labels, rules: [] } — no inbound rules = all inbound blocked,
 *                                   no outbound rules = all outbound allowed
 *  - POST   /v1/servers             { name, server_type, image, location, user_data, labels, firewalls }
 *  - DELETE /v1/servers/{id}, DELETE /v1/firewalls/{id}
 *
 * Auth: `Authorization: Bearer <token>` (project API token). Rate limit: 3600 req/h, 429 with
 * RateLimit-Reset (unix seconds).
 */

export interface HetznerOptions extends DeployerOptions {
  /** EUR→USD rate for cost display (Hetzner bills in EUR). Default 1.10. */
  eurToUsd?: number;
  /** OS image. Default ubuntu-24.04. */
  image?: string;
}

interface HPrice {
  location: string;
  price_monthly: { net: string; gross: string };
}
interface HServerType {
  id: number;
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  architecture?: string;
  deprecation?: unknown;
  deprecated?: boolean;
  prices: HPrice[];
}
interface HServer {
  id: number;
  name: string;
  status: string;
  created: string;
  server_type: { name: string };
  datacenter?: { location?: { name: string } };
  public_net?: { ipv4?: { ip?: string } | null; ipv6?: { ip?: string } | null };
  labels?: Record<string, string>;
}
interface HFirewall {
  id: number;
  name: string;
}

const STATUS: Record<string, Deployment['status']> = {
  initializing: 'provisioning',
  starting: 'provisioning',
  rebuilding: 'provisioning',
  migrating: 'provisioning',
  running: 'running',
  stopping: 'stopped',
  off: 'stopped',
  deleting: 'destroyed',
};

export class HetznerDeployer extends BaseDeployer {
  readonly id = 'hetzner';
  readonly displayName = 'Hetzner Cloud';
  readonly kind = 'vps' as const;
  protected readonly defaultBaseUrl = 'https://api.hetzner.cloud/v1';
  protected readonly defaultRegion = 'fsn1';
  protected readonly defaultSize = 'cx23';
  private types?: HServerType[];
  private pricing?: { currency: string; ipv4: HPrice[] };

  constructor(protected override readonly opts: HetznerOptions) {
    super(opts);
  }

  private get rate(): number {
    return this.opts.eurToUsd ?? 1.1;
  }

  private async serverTypes(c?: HttpClient): Promise<HServerType[]> {
    if (!this.types) {
      const http = c ?? (await this.http());
      const r = await http.get<{ server_types: HServerType[] }>('/server_types', { query: { per_page: 50 } });
      this.types = r.server_types.filter((t) => !t.deprecated && !t.deprecation);
    }
    return this.types;
  }

  private async prices(): Promise<{ currency: string; ipv4: HPrice[] }> {
    if (!this.pricing) {
      const http = await this.http();
      const r = await http.get<{
        pricing: { currency: string; primary_ips?: { type: string; prices: HPrice[] }[] };
      }>('/pricing');
      this.pricing = {
        currency: r.pricing.currency,
        ipv4: r.pricing.primary_ips?.find((p) => p.type === 'ipv4')?.prices ?? [],
      };
    }
    return this.pricing;
  }

  private toUsd(amount: string, currency: string): number {
    const n = Number(amount);
    return currency === 'USD' ? n : n * this.rate;
  }

  async sizes() {
    const types = await this.serverTypes();
    const { currency } = await this.prices();
    return types.map((t) => {
      const p = t.prices.find((x) => x.location === this.defaultRegion) ?? t.prices[0];
      return {
        id: t.name,
        label: `${t.name} — ${t.cores} vCPU, ${t.memory} GB RAM, ${t.disk} GB disk${t.architecture === 'arm' ? ' (arm64)' : ''}`,
        monthlyUsd: p ? Math.round(this.toUsd(p.price_monthly.net, currency) * 100) / 100 : 0,
      };
    });
  }

  async regions() {
    const http = await this.http();
    const r = await http.get<{
      locations: { name: string; description: string; city: string; country: string }[];
    }>('/locations');
    return r.locations.map((l) => ({ id: l.name, label: `${l.city}, ${l.country} (${l.name})` }));
  }

  /** Cheapest current x86 type with ≥2 GB RAM offered in the location. */
  protected override async pickDefaultSize(region: string): Promise<string> {
    const types = await this.serverTypes();
    const ok = types
      .filter((t) => t.memory >= 2 && t.architecture !== 'arm' && t.prices.some((p) => p.location === region))
      .sort(
        (a, b) =>
          Number(a.prices.find((p) => p.location === region)?.price_monthly.net) -
          Number(b.prices.find((p) => p.location === region)?.price_monthly.net),
      );
    return ok[0]?.name ?? this.defaultSize;
  }

  private toDeployment(agent: string, s: HServer): Deployment {
    return {
      id: deploymentId(this.id, agent),
      provider: this.id,
      agent,
      status: STATUS[s.status] ?? 'error',
      region: s.datacenter?.location?.name,
      size: s.server_type.name,
      createdAt: s.created,
      address: s.public_net?.ipv4?.ip ?? s.public_net?.ipv6?.ip ?? undefined,
    };
  }

  private async findFirewall(http: HttpClient, name: string): Promise<HFirewall | undefined> {
    const r = await http.get<{ firewalls: HFirewall[] }>('/firewalls', { query: { name } });
    return r.firewalls.find((f) => f.name === name);
  }

  protected async find(agent: string): Promise<ExistingDeployment | undefined> {
    const http = await this.http();
    const name = resourceName(agent);
    const r = await http.get<{ servers: HServer[] }>('/servers', { query: { name } });
    const s = r.servers.find((x) => x.name === name);
    if (!s) return undefined;
    const fw = await this.findFirewall(http, name);
    return {
      deployment: this.toDeployment(agent, s),
      resources: { serverId: String(s.id), ...(fw ? { firewallId: String(fw.id) } : {}) },
    };
  }

  protected async planCreate({ spec }: PlanContext) {
    const types = await this.serverTypes();
    const { currency, ipv4 } = await this.prices();
    const t = types.find((x) => x.name === spec.size);
    const p = t?.prices.find((x) => x.location === spec.region);
    if (!t || !p) {
      throw new BeamhopError('invalid_input', `server type ${spec.size} is not available in ${spec.region}`);
    }
    const ip = ipv4.find((x) => x.location === spec.region) ?? ipv4[0];
    const server = this.toUsd(p.price_monthly.net, currency);
    const ipCost = ip ? this.toUsd(ip.price_monthly.net, currency) : 0;
    const name = resourceName(spec.agent);
    const warnings = [
      `Hetzner bills in ${currency}; USD shown at ${this.rate} ${currency}→USD, excluding VAT.`,
      'No inbound ports are open. Logs and control go over Nostr.',
    ];
    return {
      actions: [
        {
          op: 'create' as const,
          resource: `firewall/${name}`,
          detail: 'No inbound rules (deny all); outbound allowed',
        },
        {
          op: 'create' as const,
          resource: `server/${name}`,
          detail: `${spec.size} in ${spec.region}, ${this.opts.image ?? 'ubuntu-24.04'}, cloud-init installs beamhop + ${spec.harnesses.join(', ')}`,
        },
      ],
      monthlyCostUsd: server + ipCost,
      warnings,
    };
  }

  protected async create(
    spec: PlanContext['spec'],
    prov: ResolvedProvisioning,
    _pkgs: string[],
  ): Promise<ExistingDeployment> {
    const http = await this.http();
    const name = resourceName(spec.agent);
    const labels = { 'managed-by': 'beamhop', 'beamhop-agent': spec.agent };
    const ssh = prov.sshAuthorizedKeys.length > 0;

    let fw = await this.findFirewall(http, name);
    if (!fw) {
      const rules = ssh
        ? [
            {
              direction: 'in',
              protocol: 'tcp',
              port: '22',
              source_ips: ['0.0.0.0/0', '::/0'],
              description: 'ssh (opt-in)',
            },
          ]
        : [];
      const r = await http.post<{ firewall: HFirewall }>('/firewalls', { name, labels, rules });
      fw = r.firewall;
    }

    const userData = renderCloudInit({
      agent: spec.agent,
      harnesses: spec.harnesses,
      beamhopVersion: prov.beamhopVersion,
      ownerNpub: prov.ownerNpub,
      daemonNsecRef: prov.daemonNsecRef,
      provisioningPubkey: prov.provisioningPubkey,
      sshAuthorizedKeys: prov.sshAuthorizedKeys,
      harnessPackages: this.opts.harnessPackages,
      provider: this.id,
    });

    // The response may contain `root_password` (when no ssh_keys are given). It is deliberately
    // discarded: root login is disabled by cloud-init and the value is never logged or stored.
    const r = await http.post<{ server: HServer }>('/servers', {
      name,
      server_type: spec.size,
      image: this.opts.image ?? 'ubuntu-24.04',
      location: spec.region,
      user_data: userData,
      labels,
      firewalls: [{ firewall: fw.id }],
      start_after_create: true,
      public_net: { enable_ipv4: true, enable_ipv6: true },
    });
    return {
      deployment: this.toDeployment(spec.agent, r.server),
      resources: { serverId: String(r.server.id), firewallId: String(fw.id) },
    };
  }

  protected async remove(agent: string, rec: DeployRecord | undefined): Promise<void> {
    const http = await this.http();
    const name = resourceName(agent);
    const found = await this.find(agent);
    const serverId = found?.resources.serverId ?? rec?.resources.serverId;
    if (serverId) await http.delete(`/servers/${serverId}`, { allow404: true });
    const fw = await this.findFirewall(http, name);
    if (!fw) return;
    // The firewall stays "in use" until the server deletion action detaches it.
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0; ; i++) {
      try {
        await http.delete(`/firewalls/${fw.id}`, { allow404: true });
        return;
      } catch (err) {
        const code = (err as BeamhopError).code;
        if ((code === 'conflict' || code === 'invalid_input') && i < 10) {
          await sleep(3000);
          continue;
        }
        throw err;
      }
    }
  }

  logs(id: string): AsyncIterable<string> {
    const agent = this.agentFromId(id);
    return noLogApi(
      this.displayName,
      `Use \`beamhop logs --agent ${agent}\` (journal of beamhopd.service, streamed over the Nostr control channel); with SSH opted in: \`ssh beamhop@<ip> journalctl -u beamhopd -f\`.`,
    );
  }
}
