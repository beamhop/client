import { BeamhopError, type Deployment } from '@beamhop/core';
import { REMOTE_BEAMHOP_HOME } from '../cloud-init.ts';
import {
  BaseDeployer,
  type DeployerOptions,
  deploymentId,
  type ExistingDeployment,
  PAAS_SANDBOX_WARNING,
  type PlanContext,
  type ResolvedProvisioning,
  resourceName,
} from '../common.ts';
import type { HttpClient } from '../http.ts';
import type { DeployRecord } from '../state.ts';

/**
 * Render deployer (PaaS). API reference: https://api-docs.render.com/reference
 * Base URL https://api.render.com/v1, `Authorization: Bearer <api key>`.
 *
 *  - GET    /owners                                  workspace id (ownerId)
 *  - GET    /services?name=&type=background_worker   idempotency lookup → [{ service, cursor }]
 *  - POST   /services                                { type: "background_worker", name, ownerId,
 *                                                     image: { ownerId, imagePath }, envVars,
 *                                                     serviceDetails: { runtime: "image", plan, region,
 *                                                     numInstances, disk } }
 *  - GET    /services/{id}/deploys                   → [{ deploy, cursor }]
 *  - POST   /services/{id}/suspend, /resume
 *  - DELETE /services/{id}
 *  - GET    /logs?ownerId=&resource=                 → { logs: [{ timestamp, message }], hasMore }
 *
 * Background workers have no inbound port. Plan prices: https://render.com/pricing (USD/month,
 * prorated by the second; workspace plan fees not included). Disks $0.25/GB-month.
 */

export interface RenderOptions extends DeployerOptions {
  /** Render workspace (owner) id; default = first owner returned by /owners. */
  ownerId?: string;
  /** Persistent disk for ~/.beamhop, in GB. Default 1. */
  diskGb?: number;
}

export const RENDER_PLANS: { id: string; label: string; monthlyUsd: number; memoryMb: number }[] = [
  {
    id: 'starter',
    label: 'Starter — 0.5 CPU, 512 MB (too small for most harnesses)',
    monthlyUsd: 7,
    memoryMb: 512,
  },
  { id: 'standard', label: 'Standard — 1 CPU, 2 GB', monthlyUsd: 25, memoryMb: 2048 },
  { id: 'pro', label: 'Pro — 2 CPU, 4 GB', monthlyUsd: 85, memoryMb: 4096 },
  { id: 'pro_plus', label: 'Pro Plus — 4 CPU, 8 GB', monthlyUsd: 175, memoryMb: 8192 },
  { id: 'pro_max', label: 'Pro Max — 4 CPU, 16 GB', monthlyUsd: 225, memoryMb: 16384 },
  { id: 'pro_ultra', label: 'Pro Ultra — 8 CPU, 32 GB', monthlyUsd: 450, memoryMb: 32768 },
];
export const RENDER_DISK_USD_PER_GB = 0.25;

export const RENDER_REGIONS = [
  { id: 'oregon', label: 'Oregon (US West)' },
  { id: 'ohio', label: 'Ohio (US East)' },
  { id: 'virginia', label: 'Virginia (US East)' },
  { id: 'frankfurt', label: 'Frankfurt (EU Central)' },
  { id: 'singapore', label: 'Singapore (Asia Pacific)' },
];

interface RService {
  id: string;
  name: string;
  type: string;
  suspended?: 'suspended' | 'not_suspended';
  createdAt: string;
  serviceDetails?: { plan?: string; region?: string };
}
interface RDeploy {
  id: string;
  status: string;
  createdAt?: string;
}

const DEPLOY_STATUS: Record<string, Deployment['status']> = {
  created: 'provisioning',
  queued: 'provisioning',
  build_in_progress: 'provisioning',
  update_in_progress: 'provisioning',
  pre_deploy_in_progress: 'provisioning',
  live: 'running',
  build_failed: 'error',
  update_failed: 'error',
  pre_deploy_failed: 'error',
  canceled: 'stopped',
  deactivated: 'stopped',
};

export class RenderDeployer extends BaseDeployer {
  readonly id = 'render';
  readonly displayName = 'Render';
  readonly kind = 'paas' as const;
  protected readonly defaultBaseUrl = 'https://api.render.com/v1';
  protected readonly defaultRegion = 'frankfurt';
  protected readonly defaultSize = 'standard';
  private owner?: string;

  constructor(protected override readonly opts: RenderOptions) {
    super(opts);
  }

  async sizes() {
    return RENDER_PLANS.map(({ id, label, monthlyUsd }) => ({ id, label, monthlyUsd }));
  }

  async regions() {
    return RENDER_REGIONS;
  }

  private async ownerId(http: HttpClient): Promise<string> {
    if (this.opts.ownerId) return this.opts.ownerId;
    if (!this.owner) {
      const r = await http.get<{ owner: { id: string } }[]>('/owners', { query: { limit: 20 } });
      const id = r[0]?.owner.id;
      if (!id) throw new BeamhopError('not_found', 'Render: no workspace found for this API key');
      this.owner = id;
    }
    return this.owner;
  }

  private async findService(http: HttpClient, name: string): Promise<RService | undefined> {
    const r = await http.get<{ service: RService }[]>('/services', {
      query: { name, type: 'background_worker', ownerId: await this.ownerId(http), limit: 20 },
    });
    return r.map((x) => x.service).find((s) => s.name === name);
  }

  private async toDeployment(http: HttpClient, agent: string, s: RService): Promise<Deployment> {
    let status: Deployment['status'] = 'provisioning';
    if (s.suspended === 'suspended') status = 'stopped';
    else {
      const d = await http.get<{ deploy: RDeploy }[]>(`/services/${s.id}/deploys`, { query: { limit: 1 } });
      const latest = d[0]?.deploy;
      if (latest) status = DEPLOY_STATUS[latest.status] ?? 'error';
    }
    return {
      id: deploymentId(this.id, agent),
      provider: this.id,
      agent,
      status,
      region: s.serviceDetails?.region,
      size: s.serviceDetails?.plan,
      createdAt: s.createdAt,
    };
  }

  protected async find(agent: string): Promise<ExistingDeployment | undefined> {
    const http = await this.http();
    const s = await this.findService(http, resourceName(agent));
    if (!s) return undefined;
    return { deployment: await this.toDeployment(http, agent, s), resources: { serviceId: s.id } };
  }

  protected async planCreate({ spec }: PlanContext) {
    const plan = RENDER_PLANS.find((p) => p.id === spec.size)!;
    const gb = this.opts.diskGb ?? 1;
    const warnings = [
      PAAS_SANDBOX_WARNING,
      'Render prices are list prices per instance-month; workspace plan fees and bandwidth are not included.',
      'Background workers have no inbound ports. Secrets arrive over the Nostr control channel, not as Render env vars.',
    ];
    if (plan.memoryMb < 1024)
      warnings.push('Less than 1 GB RAM is likely too small for Node-based harness CLIs.');
    return {
      actions: [
        {
          op: 'create' as const,
          resource: `background_worker/${resourceName(spec.agent)}`,
          detail: `${spec.size} in ${spec.region}, image ${spec.image ?? 'ghcr.io/beamhop/agent'}, ${gb} GB disk at ${REMOTE_BEAMHOP_HOME}`,
        },
      ],
      monthlyCostUsd: plan.monthlyUsd + gb * RENDER_DISK_USD_PER_GB,
      warnings,
    };
  }

  protected async create(
    spec: PlanContext['spec'],
    prov: ResolvedProvisioning,
    pkgs: string[],
  ): Promise<ExistingDeployment> {
    const http = await this.http();
    const ownerId = await this.ownerId(http);
    const env = await this.paasEnv(spec, prov, pkgs);
    const r = await http.post<{ service: RService; deployId?: string }>('/services', {
      type: 'background_worker',
      name: resourceName(spec.agent),
      ownerId,
      image: { ownerId, imagePath: this.image(spec, prov.beamhopVersion) },
      envVars: Object.entries(env).map(([key, value]) => ({ key, value })),
      autoDeploy: 'no',
      serviceDetails: {
        runtime: 'image',
        plan: spec.size,
        region: spec.region,
        numInstances: 1,
        disk: { name: 'beamhop-data', mountPath: REMOTE_BEAMHOP_HOME, sizeGB: this.opts.diskGb ?? 1 },
      },
    });
    return {
      deployment: {
        id: deploymentId(this.id, spec.agent),
        provider: this.id,
        agent: spec.agent,
        status: 'provisioning',
        region: spec.region,
        size: spec.size,
        createdAt: r.service.createdAt ?? this.now(),
      },
      resources: { serviceId: r.service.id, ownerId, ...(r.deployId ? { deployId: r.deployId } : {}) },
    };
  }

  private async serviceIdFor(id: string): Promise<{ http: HttpClient; serviceId: string }> {
    const agent = this.agentFromId(id);
    const http = await this.http();
    const s = await this.findService(http, resourceName(agent));
    if (!s) throw new BeamhopError('not_found', `no Render service for agent "${agent}"`);
    return { http, serviceId: s.id };
  }

  /** Suspend the worker (stops billing for compute; disk is kept). */
  async suspend(id: string): Promise<void> {
    const { http, serviceId } = await this.serviceIdFor(id);
    await http.post(`/services/${serviceId}/suspend`);
  }

  async resume(id: string): Promise<void> {
    const { http, serviceId } = await this.serviceIdFor(id);
    await http.post(`/services/${serviceId}/resume`);
  }

  async deploys(id: string): Promise<{ id: string; status: string; createdAt?: string }[]> {
    const { http, serviceId } = await this.serviceIdFor(id);
    const r = await http.get<{ deploy: RDeploy }[]>(`/services/${serviceId}/deploys`, {
      query: { limit: 20 },
    });
    return r.map((x) => x.deploy);
  }

  protected async remove(agent: string, rec: DeployRecord | undefined): Promise<void> {
    const http = await this.http();
    const s = await this.findService(http, resourceName(agent));
    const serviceId = s?.id ?? rec?.resources.serviceId;
    if (serviceId) await http.delete(`/services/${serviceId}`, { allow404: true });
  }

  async *logs(id: string): AsyncIterable<string> {
    const { http, serviceId } = await this.serviceIdFor(id);
    const ownerId = await this.ownerId(http);
    const r = await http.get<{ logs: { timestamp: string; message: string }[]; hasMore?: boolean }>('/logs', {
      query: { ownerId, resource: serviceId, limit: 100, direction: 'backward' },
    });
    // API returns newest first when direction=backward; print chronologically.
    for (const l of [...(r.logs ?? [])].reverse()) yield `${l.timestamp} ${l.message}`;
  }
}
