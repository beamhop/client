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
import { GraphQLClient } from '../http.ts';
import type { DeployRecord } from '../state.ts';

/**
 * Railway deployer (PaaS). Public API: https://docs.railway.com/reference/public-api
 * GraphQL endpoint https://backboard.railway.com/graphql/v2, `Authorization: Bearer <account or
 * workspace token>` (project tokens cannot create projects). 429 + Retry-After on rate limit.
 *
 * Operations (https://docs.railway.com/integrations/api/*):
 *  - projects / project(id)                  idempotency lookup by project name `beamhop-<agent>`
 *  - projectCreate(input: { name, description, workspaceId, isPublic: false })
 *  - serviceCreate(input: { projectId, name, source: { image } })
 *  - variableCollectionUpsert(input: { projectId, environmentId, serviceId, variables, skipDeploys })
 *  - volumeCreate(input: { projectId, serviceId, environmentId, mountPath })
 *  - serviceInstanceUpdate(serviceId, environmentId, input: { region, numReplicas, restartPolicyType })
 *  - serviceInstanceDeployV2(serviceId, environmentId) → deployment id
 *  - serviceInstance(...) { latestDeployment { id status createdAt } }
 *  - deploymentLogs(deploymentId, limit)
 *  - projectDelete(id)
 *
 * Services without a domain or TCP proxy have no inbound exposure. Pricing is usage-based
 * (https://docs.railway.com/reference/pricing/plans): $20/vCPU-month, $10/GB-RAM-month,
 * $0.15/GB-month volumes, $0.05/GB egress — so "sizes" are usage assumptions.
 */

export interface RailwayOptions extends DeployerOptions {
  workspaceId?: string;
  /** Persistent volume is always created; egress assumption for the estimate, GB/month. Default 5. */
  egressGbPerMonth?: number;
  volumeGb?: number;
}

export const RAILWAY_RATES = { vcpuMonth: 20, gbRamMonth: 10, volumeGbMonth: 0.15, egressGb: 0.05 };

export const RAILWAY_USAGE_PROFILES = [
  { id: 'usage-small', vcpu: 0.25, ramGb: 1, label: 'Light use (avg 0.25 vCPU, 1 GB RAM)' },
  { id: 'usage-medium', vcpu: 0.5, ramGb: 2, label: 'Moderate use (avg 0.5 vCPU, 2 GB RAM)' },
  { id: 'usage-large', vcpu: 1, ramGb: 4, label: 'Heavy use (avg 1 vCPU, 4 GB RAM)' },
];

export const RAILWAY_REGIONS = [
  { id: 'us-west2', label: 'US West (California)' },
  { id: 'us-east4-eqdc4a', label: 'US East (Virginia)' },
  { id: 'europe-west4-drams3a', label: 'EU West (Amsterdam)' },
  { id: 'asia-southeast1-eqsg3a', label: 'Southeast Asia (Singapore)' },
];

const computeUsd = (p: { vcpu: number; ramGb: number }) =>
  p.vcpu * RAILWAY_RATES.vcpuMonth + p.ramGb * RAILWAY_RATES.gbRamMonth;

const STATUS: Record<string, Deployment['status']> = {
  QUEUED: 'provisioning',
  WAITING: 'provisioning',
  INITIALIZING: 'provisioning',
  BUILDING: 'provisioning',
  DEPLOYING: 'provisioning',
  SUCCESS: 'running',
  SLEEPING: 'stopped',
  SKIPPED: 'stopped',
  CRASHED: 'error',
  FAILED: 'error',
  REMOVING: 'destroyed',
  REMOVED: 'destroyed',
};

interface Edges<T> {
  edges: { node: T }[];
}
interface RProject {
  id: string;
  name: string;
  createdAt?: string;
  environments: Edges<{ id: string; name: string }>;
  services: Edges<{ id: string; name: string }>;
  volumes?: Edges<{ id: string; name: string }>;
}

const PROJECT_FIELDS = `id name createdAt
  environments { edges { node { id name } } }
  services { edges { node { id name } } }
  volumes { edges { node { id name } } }`;

export const Q = {
  projects: `query projects($workspaceId: String) { projects(workspaceId: $workspaceId) { edges { node { ${PROJECT_FIELDS} } } } }`,
  project: `query project($id: String!) { project(id: $id) { ${PROJECT_FIELDS} } }`,
  projectCreate: `mutation projectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id name } }`,
  serviceCreate: `mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
  variables: `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
  volumeCreate: `mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name } }`,
  instanceUpdate: `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
  deploy: `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
  instance: `query serviceInstance($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { id region latestDeployment { id status createdAt } } }`,
  logs: `query deploymentLogs($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity } }`,
  projectDelete: `mutation projectDelete($id: String!) { projectDelete(id: $id) }`,
};

export class RailwayDeployer extends BaseDeployer {
  readonly id = 'railway';
  readonly displayName = 'Railway';
  readonly kind = 'paas' as const;
  protected readonly defaultBaseUrl = 'https://backboard.railway.com';
  protected readonly defaultRegion = 'europe-west4-drams3a';
  protected readonly defaultSize = 'usage-small';

  constructor(protected override readonly opts: RailwayOptions) {
    super(opts);
  }

  private async gql(): Promise<GraphQLClient> {
    return new GraphQLClient(await this.http(), '/graphql/v2', this.id);
  }

  private fixedMonthly(): number {
    return (
      (this.opts.volumeGb ?? 1) * RAILWAY_RATES.volumeGbMonth +
      (this.opts.egressGbPerMonth ?? 5) * RAILWAY_RATES.egressGb
    );
  }

  async sizes() {
    return RAILWAY_USAGE_PROFILES.map((p) => ({
      id: p.id,
      label: `${p.label} — estimate`,
      monthlyUsd: Math.round((computeUsd(p) + this.fixedMonthly()) * 100) / 100,
    }));
  }

  async regions() {
    return RAILWAY_REGIONS;
  }

  private async findProject(g: GraphQLClient, name: string): Promise<RProject | undefined> {
    const r = await g.query<{ projects: Edges<RProject> }>(Q.projects, {
      workspaceId: this.opts.workspaceId ?? null,
    });
    return r.projects.edges.map((e) => e.node).find((p) => p.name === name);
  }

  private envOf(p: RProject): string {
    const envs = p.environments.edges.map((e) => e.node);
    const env = envs.find((e) => e.name === 'production') ?? envs[0];
    if (!env) throw new BeamhopError('internal', `Railway project ${p.name} has no environment`);
    return env.id;
  }

  protected async find(agent: string): Promise<ExistingDeployment | undefined> {
    const g = await this.gql();
    const name = resourceName(agent);
    const p = await this.findProject(g, name);
    if (!p) return undefined;
    const svc = p.services.edges.map((e) => e.node).find((s) => s.name === name);
    if (!svc) return undefined;
    const environmentId = this.envOf(p);
    const r = await g.query<{
      serviceInstance: {
        region?: string;
        latestDeployment: { id: string; status: string; createdAt: string } | null;
      };
    }>(Q.instance, { serviceId: svc.id, environmentId });
    const dep = r.serviceInstance?.latestDeployment;
    if (!dep) return undefined; // created but never deployed → apply resumes
    return {
      deployment: {
        id: deploymentId(this.id, agent),
        provider: this.id,
        agent,
        status: STATUS[dep.status] ?? 'error',
        region: r.serviceInstance.region,
        createdAt: p.createdAt ?? dep.createdAt,
      },
      resources: { projectId: p.id, serviceId: svc.id, environmentId, deploymentId: dep.id },
    };
  }

  protected async planCreate({ spec }: PlanContext) {
    const profile = RAILWAY_USAGE_PROFILES.find((p) => p.id === spec.size)!;
    const name = resourceName(spec.agent);
    return {
      actions: [
        { op: 'create' as const, resource: `project/${name}`, detail: 'Private Railway project' },
        {
          op: 'create' as const,
          resource: `service/${name}`,
          detail: `image ${spec.image ?? 'ghcr.io/beamhop/agent'} in ${spec.region}, no domain/TCP proxy`,
        },
        {
          op: 'create' as const,
          resource: 'volume',
          detail: `${this.opts.volumeGb ?? 1} GB at ${REMOTE_BEAMHOP_HOME}`,
        },
      ],
      monthlyCostUsd: computeUsd(profile) + this.fixedMonthly(),
      warnings: [
        PAAS_SANDBOX_WARNING,
        `Railway pricing is usage-based: this is an estimate assuming ${profile.label.toLowerCase()}, ${this.opts.egressGbPerMonth ?? 5} GB egress and ${this.opts.volumeGb ?? 1} GB volume. Actual cost depends on real usage; the plan subscription fee (Hobby $5 / Pro $20, which includes the same amount of usage) is not included.`,
        'No domain or TCP proxy is created: the service has no inbound exposure. Secrets arrive over the Nostr control channel, not as Railway variables.',
      ],
    };
  }

  protected async create(
    spec: PlanContext['spec'],
    prov: ResolvedProvisioning,
    pkgs: string[],
  ): Promise<ExistingDeployment> {
    const g = await this.gql();
    const name = resourceName(spec.agent);

    let project = await this.findProject(g, name);
    if (!project) {
      const c = await g.query<{ projectCreate: { id: string } }>(Q.projectCreate, {
        input: {
          name,
          description: `beamhop agent ${spec.agent}`,
          isPublic: false,
          ...(this.opts.workspaceId ? { workspaceId: this.opts.workspaceId } : {}),
        },
      });
      const r = await g.query<{ project: RProject }>(Q.project, { id: c.projectCreate.id });
      project = r.project;
    }
    const projectId = project.id;
    const environmentId = this.envOf(project);

    let serviceId = project.services.edges.map((e) => e.node).find((s) => s.name === name)?.id;
    if (!serviceId) {
      const s = await g.query<{ serviceCreate: { id: string } }>(Q.serviceCreate, {
        input: { projectId, environmentId, name, source: { image: this.image(spec, prov.beamhopVersion) } },
      });
      serviceId = s.serviceCreate.id;
    }

    const env = await this.paasEnv(spec, prov, pkgs);
    await g.query(Q.variables, {
      input: { projectId, environmentId, serviceId, variables: env, skipDeploys: true },
    });

    if (!project.volumes?.edges.length) {
      await g.query(Q.volumeCreate, {
        input: { projectId, serviceId, environmentId, mountPath: REMOTE_BEAMHOP_HOME },
      });
    }

    await g.query(Q.instanceUpdate, {
      serviceId,
      environmentId,
      input: { region: spec.region, numReplicas: 1, restartPolicyType: 'ALWAYS' },
    });

    const d = await g.query<{ serviceInstanceDeployV2: string }>(Q.deploy, { serviceId, environmentId });
    return {
      deployment: {
        id: deploymentId(this.id, spec.agent),
        provider: this.id,
        agent: spec.agent,
        status: 'provisioning',
        region: spec.region,
        size: spec.size,
        createdAt: project.createdAt ?? this.now(),
      },
      resources: { projectId, serviceId, environmentId, deploymentId: d.serviceInstanceDeployV2 },
    };
  }

  protected async remove(agent: string, rec: DeployRecord | undefined): Promise<void> {
    const g = await this.gql();
    const p = await this.findProject(g, resourceName(agent));
    const id = p?.id ?? rec?.resources.projectId;
    if (!id) return;
    try {
      await g.query(Q.projectDelete, { id });
    } catch (err) {
      if ((err as BeamhopError).code !== 'not_found') throw err;
    }
  }

  async *logs(id: string): AsyncIterable<string> {
    const agent = this.agentFromId(id);
    const found = await this.find(agent);
    if (!found?.resources.deploymentId)
      throw new BeamhopError('not_found', `no Railway deployment for "${agent}"`);
    const g = await this.gql();
    const r = await g.query<{ deploymentLogs: { timestamp: string; message: string; severity?: string }[] }>(
      Q.logs,
      {
        deploymentId: found.resources.deploymentId,
        limit: 200,
      },
    );
    for (const l of r.deploymentLogs)
      yield `${l.timestamp} ${l.severity ? `${l.severity} ` : ''}${l.message}`;
  }
}
