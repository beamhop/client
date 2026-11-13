import { BeamhopError, type Deployment } from '@beamhop/core';
import { REMOTE_BEAMHOP_HOME } from '../cloud-init.ts';
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
import type { DeployRecord } from '../state.ts';

/**
 * Fly.io deployer (Machines API). Reference: https://docs.fly.io/machines/api/
 * Base URL https://api.machines.dev/v1, `Authorization: Bearer <token>` (or a `FlyV1 …` macaroon
 * token sent as-is).
 *
 *  - GET    /apps/{app}                       idempotency lookup (404 = absent)
 *  - POST   /apps                             { app_name, org_slug }
 *  - GET    /apps/{app}/volumes, POST /apps/{app}/volumes { name, region, size_gb, encrypted }
 *  - GET    /apps/{app}/machines, POST /apps/{app}/machines { name, region, config: { image, env, guest,
 *                                             restart, mounts } } — no `services` → no public ports, and no
 *                                             IPs are allocated for the app
 *  - DELETE /apps/{app}/machines/{id}?force=true, DELETE /apps/{app}
 *
 * Secrets are delivered over the Nostr control channel, NOT as Fly secrets: Fly would hold them
 * in plaintext-accessible form and they would need to be pushed from the owner's machine anyway.
 *
 * Prices: https://fly.io/docs/about/pricing/ (iad/ewr, 30 days running). shared-cpu-1x 256 MB
 * $2.19, 512 MB $3.69, 1 GB $6.70; shared-cpu-2x 2 GB $13.39; performance-1x 2 GB $33.00 are the
 * published presets; 2 GB/1x and 4 GB/2x are derived from the published per-256 MB step ($1.50).
 * Volumes $0.15/GB-month.
 */

export interface FlyOptions extends DeployerOptions {
  /** Fly organization slug. Default "personal". */
  orgSlug?: string;
  /** Persistent volume for ~/.beamhop, in GB. Default 1. */
  volumeGb?: number;
}

interface FlySize {
  id: string;
  label: string;
  monthlyUsd: number;
  guest: { cpu_kind: 'shared' | 'performance'; cpus: number; memory_mb: number };
}

export const FLY_SIZES: FlySize[] = [
  {
    id: 'shared-cpu-1x-256mb',
    label: 'shared-cpu-1x, 256 MB (too small for most harnesses)',
    monthlyUsd: 2.19,
    guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
  },
  {
    id: 'shared-cpu-1x-512mb',
    label: 'shared-cpu-1x, 512 MB',
    monthlyUsd: 3.69,
    guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
  },
  {
    id: 'shared-cpu-1x-1gb',
    label: 'shared-cpu-1x, 1 GB',
    monthlyUsd: 6.7,
    guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
  },
  {
    id: 'shared-cpu-1x-2gb',
    label: 'shared-cpu-1x, 2 GB',
    monthlyUsd: 12.7,
    guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 2048 },
  },
  {
    id: 'shared-cpu-2x-2gb',
    label: 'shared-cpu-2x, 2 GB',
    monthlyUsd: 13.39,
    guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 },
  },
  {
    id: 'shared-cpu-2x-4gb',
    label: 'shared-cpu-2x, 4 GB',
    monthlyUsd: 25.39,
    guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 },
  },
  {
    id: 'performance-1x-2gb',
    label: 'performance-1x, 2 GB',
    monthlyUsd: 33,
    guest: { cpu_kind: 'performance', cpus: 1, memory_mb: 2048 },
  },
];

export const FLY_VOLUME_USD_PER_GB = 0.15;

/** Fly regions (https://fly.io/docs/reference/regions/). */
export const FLY_REGIONS: { id: string; label: string }[] = [
  ['ams', 'Amsterdam, Netherlands'],
  ['arn', 'Stockholm, Sweden'],
  ['bom', 'Mumbai, India'],
  ['cdg', 'Paris, France'],
  ['dfw', 'Dallas, Texas (US)'],
  ['ewr', 'Secaucus, NJ (US)'],
  ['fra', 'Frankfurt, Germany'],
  ['gru', 'São Paulo, Brazil'],
  ['iad', 'Ashburn, Virginia (US)'],
  ['jnb', 'Johannesburg, South Africa'],
  ['lax', 'Los Angeles, California (US)'],
  ['lhr', 'London, United Kingdom'],
  ['nrt', 'Tokyo, Japan'],
  ['ord', 'Chicago, Illinois (US)'],
  ['sin', 'Singapore'],
  ['sjc', 'San Jose, California (US)'],
  ['syd', 'Sydney, Australia'],
  ['yyz', 'Toronto, Canada'],
].map(([id, label]) => ({ id: id!, label: `${label} (${id})` }));

interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  created_at: string;
  private_ip?: string;
  config?: { guest?: FlySize['guest']; image?: string };
}
interface FlyVolume {
  id: string;
  name: string;
  region: string;
  state?: string;
}

const STATUS: Record<string, Deployment['status']> = {
  created: 'provisioning',
  starting: 'provisioning',
  replacing: 'provisioning',
  updating: 'provisioning',
  started: 'running',
  stopping: 'stopped',
  stopped: 'stopped',
  suspended: 'stopped',
  suspending: 'stopped',
  destroying: 'destroyed',
  destroyed: 'destroyed',
  failed: 'error',
};

const VOLUME_NAME = 'beamhop_data';

export class FlyDeployer extends BaseDeployer {
  readonly id = 'fly';
  readonly displayName = 'Fly.io';
  readonly kind = 'paas' as const;
  protected readonly defaultBaseUrl = 'https://api.machines.dev/v1';
  protected readonly defaultRegion = 'fra';
  protected readonly defaultSize = 'shared-cpu-1x-1gb';

  constructor(protected override readonly opts: FlyOptions) {
    super(opts);
  }

  protected override authHeaders(token: string): Record<string, string> {
    return { authorization: token.startsWith('FlyV1 ') ? token : `Bearer ${token}` };
  }

  async sizes() {
    return FLY_SIZES.map(({ id, label, monthlyUsd }) => ({ id, label, monthlyUsd }));
  }

  async regions() {
    return FLY_REGIONS;
  }

  private sizeFor(m: FlyMachine): string | undefined {
    const g = m.config?.guest;
    if (!g) return undefined;
    return FLY_SIZES.find(
      (s) => s.guest.cpu_kind === g.cpu_kind && s.guest.cpus === g.cpus && s.guest.memory_mb === g.memory_mb,
    )?.id;
  }

  private toDeployment(agent: string, m: FlyMachine): Deployment {
    return {
      id: deploymentId(this.id, agent),
      provider: this.id,
      agent,
      status: STATUS[m.state] ?? 'error',
      region: m.region,
      size: this.sizeFor(m),
      createdAt: m.created_at,
      // Private 6PN address only: the app has no public IPs.
      address: m.private_ip,
    };
  }

  protected async find(agent: string): Promise<ExistingDeployment | undefined> {
    const http = await this.http();
    const app = resourceName(agent);
    const a = await http.get<{ name: string }>(`/apps/${app}`, { allow404: true });
    if (!a) return undefined;
    const machines = (await http.get<FlyMachine[]>(`/apps/${app}/machines`)) ?? [];
    const m = machines.find((x) => x.name === app);
    if (!m) return undefined; // app exists but machine missing → apply completes it
    return { deployment: this.toDeployment(agent, m), resources: { app, machineId: m.id } };
  }

  protected async planCreate({ spec }: PlanContext) {
    const size = FLY_SIZES.find((s) => s.id === spec.size)!;
    const gb = this.opts.volumeGb ?? 1;
    const app = resourceName(spec.agent);
    const warnings = [
      'Fly machines are Firecracker VMs; srt is expected to run normally, but `beamhop doctor` verifies user namespaces on first boot.',
      'Fly prices vary by region; the estimate uses the published iad/ewr rates for a machine running all month.',
      'No services or IPs are configured: the machine has no public ports. Secrets arrive over the Nostr control channel, not as Fly secrets.',
    ];
    if (size.guest.memory_mb < 1024)
      warnings.push('Less than 1 GB RAM is likely too small for Node-based harness CLIs.');
    return {
      actions: [
        {
          op: 'create' as const,
          resource: `app/${app}`,
          detail: `Fly app in org ${this.opts.orgSlug ?? 'personal'}`,
        },
        {
          op: 'create' as const,
          resource: `volume/${VOLUME_NAME}`,
          detail: `${gb} GB encrypted volume at ${REMOTE_BEAMHOP_HOME}`,
        },
        {
          op: 'create' as const,
          resource: `machine/${app}`,
          detail: `${spec.size} in ${spec.region}, image ${spec.image ?? 'ghcr.io/beamhop/agent'}, restart always`,
        },
      ],
      monthlyCostUsd: size.monthlyUsd + gb * FLY_VOLUME_USD_PER_GB,
      warnings,
    };
  }

  protected async create(
    spec: PlanContext['spec'],
    prov: ResolvedProvisioning,
    pkgs: string[],
  ): Promise<ExistingDeployment> {
    const http = await this.http();
    const app = resourceName(spec.agent);
    const size = FLY_SIZES.find((s) => s.id === spec.size)!;

    const existingApp = await http.get(`/apps/${app}`, { allow404: true });
    if (!existingApp) {
      try {
        await http.post('/apps', { app_name: app, org_slug: this.opts.orgSlug ?? 'personal' });
      } catch (err) {
        if ((err as BeamhopError).code === 'invalid_input' || (err as BeamhopError).code === 'conflict') {
          throw new BeamhopError(
            'conflict',
            `Fly app name ${app} is unavailable (Fly app names are global): ${(err as Error).message}`,
          );
        }
        throw err;
      }
    }

    const volumes = (await http.get<FlyVolume[]>(`/apps/${app}/volumes`)) ?? [];
    let vol = volumes.find((v) => v.name === VOLUME_NAME && v.region === spec.region);
    if (!vol) {
      vol = await http.post<FlyVolume>(`/apps/${app}/volumes`, {
        name: VOLUME_NAME,
        region: spec.region,
        size_gb: this.opts.volumeGb ?? 1,
        encrypted: true,
      });
    }

    const env = await this.paasEnv(spec, prov, pkgs);
    const m = await http.post<FlyMachine>(`/apps/${app}/machines`, {
      name: app,
      region: spec.region,
      config: {
        image: this.image(spec, prov.beamhopVersion),
        env,
        guest: size.guest,
        restart: { policy: 'always' },
        mounts: [{ volume: vol.id, path: REMOTE_BEAMHOP_HOME }],
        auto_destroy: false,
        metadata: { 'managed-by': 'beamhop', 'beamhop-agent': spec.agent },
      },
    });
    return {
      deployment: this.toDeployment(spec.agent, m),
      resources: { app, machineId: m.id, volumeId: vol.id },
    };
  }

  protected async remove(agent: string, _rec: DeployRecord | undefined): Promise<void> {
    const http = await this.http();
    const app = resourceName(agent);
    const exists = await http.get(`/apps/${app}`, { allow404: true });
    if (!exists) return;
    const machines = (await http.get<FlyMachine[]>(`/apps/${app}/machines`)) ?? [];
    for (const m of machines) {
      await http.delete(`/apps/${app}/machines/${m.id}`, { query: { force: true }, allow404: true });
    }
    await http.delete(`/apps/${app}`, { allow404: true });
  }

  logs(id: string): AsyncIterable<string> {
    const agent = this.agentFromId(id);
    return noLogApi(
      this.displayName,
      `The Machines API has no log endpoint; use \`beamhop logs --agent ${agent}\` (over Nostr) or \`fly logs -a ${resourceName(agent)}\`.`,
    );
  }
}
