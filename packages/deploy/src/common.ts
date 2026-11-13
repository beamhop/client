import {
  BeamhopError,
  type Deployer,
  type Deployment,
  type DeployPlan,
  type DeploySpec,
  type Logger,
  type SecretStore,
  silentLogger,
} from '@beamhop/core';
import { REMOTE_BEAMHOP_HOME } from './cloud-init.ts';
import { resolveHarnessPackages } from './harness-packages.ts';
import { type FetchLike, HttpClient } from './http.ts';
import { type DeployRecord, DeployState } from './state.ts';
import {
  assertAgentSlug,
  assertNoSecrets,
  assertNpub,
  assertProvisioningToken,
  assertPubkey,
  assertSecretRef,
  assertVersion,
} from './validate.ts';

/** Non-secret values the daemon supplies so a fresh host can be provisioned over Nostr later. */
export interface ProvisioningInfo {
  ownerNpub: string;
  /** One-time provisioning public key; its secret half never leaves the owner's machine. */
  provisioningPubkey: string;
  /**
   * One-time binding token the host proves in its provisioning hello (review wave C PROV-1). It
   * only authorizes *receiving* the first provisioning and is deleted once that happened.
   */
  provisioningToken?: string;
  /** Exact beamhop version to install (follows the owner's local version, §12). */
  beamhopVersion: string;
  /** Vault reference for the daemon's nsec; default `agent.<agent>.nsec`. */
  daemonNsecRef?: string;
  /** VPS only: opt-in SSH public keys (needed for rsync "move to cloud" of non-git mounts). */
  sshAuthorizedKeys?: string[];
}

export type ResolvedProvisioning = Required<
  Omit<ProvisioningInfo, 'sshAuthorizedKeys' | 'provisioningToken'>
> & {
  sshAuthorizedKeys: string[];
  provisioningToken?: string;
};

export interface DeployerOptions {
  /** Provider tokens are read from here as `deploy.<provider>.token`. They never reach the host. */
  secrets: SecretStore;
  /** Supplies owner npub, provisioning pubkey and version at apply time. */
  provisioning: (spec: DeploySpec) => Promise<ProvisioningInfo> | ProvisioningInfo;
  state?: DeployState;
  fetch?: FetchLike;
  /** Override the provider API base URL (tests). */
  baseUrl?: string;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** Spend cap (§7A): `apply` refuses plans above this monthly estimate. */
  maxMonthlyUsd?: number;
  /** Harness → npm package overrides (from the signed catalog). */
  harnessPackages?: Record<string, string[]>;
  now?: () => Date;
}

export const tokenSecretName = (provider: string): string => `deploy.${provider}.token`;
export const resourceName = (agent: string): string => `beamhop-${agent}`;
export const deploymentId = (provider: string, agent: string): string => `${provider}:${agent}`;

export const PAAS_SANDBOX_WARNING =
  'srt may not have user namespaces here; container boundary + broker egress proxy apply (§7). `beamhop doctor` on the host reports which mode is active.';

export const DEFAULT_IMAGE = 'ghcr.io/beamhop/agent';

export interface ExistingDeployment {
  deployment: Deployment;
  resources: Record<string, string>;
}

export interface PlanContext {
  spec: DeploySpec & { region: string; size: string };
  existing?: ExistingDeployment;
}

/**
 * Shared deployer skeleton: validation, idempotency, spend cap and state bookkeeping. Providers
 * implement the API-specific hooks.
 */
export abstract class BaseDeployer implements Deployer {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly kind: 'vps' | 'paas';
  protected abstract readonly defaultBaseUrl: string;
  protected abstract readonly defaultRegion: string;
  protected abstract readonly defaultSize: string;

  protected readonly log: Logger;
  protected readonly state: DeployState;

  constructor(protected readonly opts: DeployerOptions) {
    this.log = opts.log ?? silentLogger;
    this.state = opts.state ?? new DeployState();
  }

  abstract sizes(): Promise<{ id: string; label: string; monthlyUsd: number }[]>;
  abstract regions(): Promise<{ id: string; label: string }[]>;
  /** Look up the deployment by its deterministic name (`beamhop-<agent>`). */
  protected abstract find(agent: string): Promise<ExistingDeployment | undefined>;
  /** Default size when the spec has none; providers with dynamic catalogs override this. */
  protected async pickDefaultSize(_region: string): Promise<string> {
    return this.defaultSize;
  }
  protected abstract planCreate(ctx: PlanContext): Promise<{
    actions: DeployPlan['actions'];
    monthlyCostUsd: number;
    warnings: string[];
  }>;
  protected abstract create(
    spec: PlanContext['spec'],
    prov: ResolvedProvisioning,
    harnessPackages: string[],
  ): Promise<ExistingDeployment>;
  protected abstract remove(agent: string, rec: DeployRecord | undefined): Promise<void>;
  abstract logs(id: string): AsyncIterable<string>;

  protected async token(): Promise<string> {
    const t = await this.opts.secrets.get(tokenSecretName(this.id));
    if (!t) {
      throw new BeamhopError(
        'unauthorized',
        `no ${this.displayName} API token: store one with \`beamhop secret set ${tokenSecretName(this.id)}\``,
      );
    }
    return t;
  }

  protected authHeaders(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  protected async http(baseUrl = this.opts.baseUrl ?? this.defaultBaseUrl): Promise<HttpClient> {
    const token = await this.token();
    return new HttpClient({
      provider: this.id,
      baseUrl,
      token,
      auth: (t) => this.authHeaders(t),
      fetch: this.opts.fetch,
      sleep: this.opts.sleep,
      maxRetries: this.opts.maxRetries,
      log: this.log,
    });
  }

  protected now(): string {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }

  protected agentFromId(id: string): string {
    const prefix = `${this.id}:`;
    if (!id.startsWith(prefix))
      throw new BeamhopError('invalid_input', `deployment id "${id}" is not a ${this.id} id`);
    return assertAgentSlug(id.slice(prefix.length));
  }

  protected async normalize(spec: DeploySpec): Promise<PlanContext['spec']> {
    if (spec.provider !== this.id) {
      throw new BeamhopError('invalid_input', `spec.provider "${spec.provider}" does not match ${this.id}`);
    }
    assertAgentSlug(spec.agent);
    if (!spec.harnesses.length) throw new BeamhopError('invalid_input', 'select at least one harness');
    resolveHarnessPackages(spec.harnesses, this.opts.harnessPackages);
    const region = spec.region ?? this.defaultRegion;
    const size = spec.size ?? (await this.pickDefaultSize(region));
    const regions = await this.regions();
    if (!regions.some((r) => r.id === region)) {
      throw new BeamhopError('invalid_input', `unknown ${this.displayName} region "${region}"`);
    }
    const sizes = await this.sizes();
    if (!sizes.some((s) => s.id === size)) {
      throw new BeamhopError('invalid_input', `unknown ${this.displayName} size "${size}"`);
    }
    return { ...spec, region, size };
  }

  async plan(spec: DeploySpec): Promise<DeployPlan> {
    const s = await this.normalize(spec);
    const existing = await this.find(s.agent);
    const p = await this.planCreate({ spec: s, existing });
    const warnings = [...p.warnings];
    if (existing) {
      warnings.unshift(
        `${resourceName(s.agent)} already exists on ${this.displayName} (${existing.deployment.status}); apply is a no-op.`,
      );
    }
    if (s.mode === 'move') {
      warnings.push(
        'Move to cloud: config and identity move over the Nostr control channel after the host is up; the local copy stops or stays as standby. See the mount sync plan.',
      );
    }
    if (this.opts.maxMonthlyUsd !== undefined && p.monthlyCostUsd > this.opts.maxMonthlyUsd) {
      warnings.push(
        `Estimated $${p.monthlyCostUsd.toFixed(2)}/month exceeds the deploy cap of $${this.opts.maxMonthlyUsd.toFixed(2)}; owner approval required.`,
      );
    }
    return {
      provider: this.id,
      actions: existing ? [] : p.actions,
      monthlyCostUsd: round2(p.monthlyCostUsd),
      warnings,
    };
  }

  async apply(spec: DeploySpec): Promise<Deployment> {
    const s = await this.normalize(spec);
    const id = deploymentId(this.id, s.agent);
    const existing = await this.find(s.agent);
    if (existing) {
      this.log.info('deployment already exists; apply is a no-op', { id });
      await this.record(existing, undefined);
      return existing.deployment;
    }
    const p = await this.planCreate({ spec: s });
    if (this.opts.maxMonthlyUsd !== undefined && p.monthlyCostUsd > this.opts.maxMonthlyUsd) {
      throw new BeamhopError(
        'budget_exceeded',
        `estimated $${p.monthlyCostUsd.toFixed(2)}/month exceeds the deploy cap of $${this.opts.maxMonthlyUsd.toFixed(2)}`,
      );
    }
    const raw = await this.opts.provisioning(s);
    const prov = {
      ownerNpub: assertNpub(raw.ownerNpub),
      provisioningPubkey: assertPubkey(raw.provisioningPubkey),
      ...(raw.provisioningToken ? { provisioningToken: assertProvisioningToken(raw.provisioningToken) } : {}),
      beamhopVersion: assertVersion(raw.beamhopVersion),
      daemonNsecRef: assertSecretRef(raw.daemonNsecRef ?? `agent.${s.agent}.nsec`),
      sshAuthorizedKeys: raw.sshAuthorizedKeys ?? [],
    };
    const pkgs = resolveHarnessPackages(s.harnesses, this.opts.harnessPackages);
    const created = await this.create(s, prov, pkgs);
    await this.record(created, round2(p.monthlyCostUsd));
    return created.deployment;
  }

  private async record(e: ExistingDeployment, monthlyCostUsd: number | undefined): Promise<void> {
    await this.state.upsert({
      ...e.deployment,
      ...(monthlyCostUsd !== undefined ? { monthlyCostUsd } : {}),
      resources: e.resources,
    });
  }

  async status(id: string): Promise<Deployment> {
    const agent = this.agentFromId(id);
    const found = await this.find(agent);
    if (!found) {
      const rec = await this.state.get(id);
      if (rec) {
        const gone = { ...rec, status: 'destroyed' as const };
        await this.state.upsert(gone);
        return stripRecord(gone);
      }
      throw new BeamhopError('not_found', `no ${this.displayName} deployment for agent "${agent}"`);
    }
    await this.record(found, undefined);
    return found.deployment;
  }

  async destroy(id: string): Promise<void> {
    const agent = this.agentFromId(id);
    const rec = await this.state.get(id);
    // A record already marked destroyed carries stale resource ids; rely on the name lookup only.
    await this.remove(agent, rec?.status === 'destroyed' ? undefined : rec);
    if (rec) await this.state.upsert({ ...rec, status: 'destroyed' });
  }

  /** Environment for PaaS containers: non-secret only, checked for secret-looking values. */
  protected async paasEnv(
    spec: PlanContext['spec'],
    prov: {
      ownerNpub: string;
      provisioningPubkey: string;
      provisioningToken?: string;
      beamhopVersion: string;
      daemonNsecRef: string;
    },
    harnessPackages: string[],
  ): Promise<Record<string, string>> {
    const env: Record<string, string> = {
      BEAMHOP_HOME: REMOTE_BEAMHOP_HOME,
      BEAMHOP_AGENT: spec.agent,
      BEAMHOP_VERSION: prov.beamhopVersion,
      BEAMHOP_OWNER_NPUB: prov.ownerNpub,
      BEAMHOP_PROVISIONING_PUBKEY: prov.provisioningPubkey,
      ...(prov.provisioningToken ? { BEAMHOP_PROVISIONING_TOKEN: prov.provisioningToken } : {}),
      BEAMHOP_DAEMON_NSEC_REF: prov.daemonNsecRef,
      BEAMHOP_AWAIT_PROVISIONING: '1',
      BEAMHOP_HARNESSES: spec.harnesses.join(','),
      BEAMHOP_HARNESS_PACKAGES: harnessPackages.join(' '),
      BEAMHOP_DEPLOY_PROVIDER: this.id,
    };
    assertNoSecrets(JSON.stringify(env), 'container environment', [await this.token()]);
    return env;
  }

  protected image(spec: DeploySpec, version: string): string {
    const img = spec.image ?? `${DEFAULT_IMAGE}:${version}`;
    if (!/^[a-z0-9][a-z0-9./_:@-]{0,254}$/i.test(img))
      throw new BeamhopError('invalid_input', `invalid image "${img}"`);
    return img;
  }
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export const stripRecord = (r: DeployRecord): Deployment => {
  const { resources: _r, updatedAt: _u, monthlyCostUsd: _m, ...d } = r;
  return d;
};

/** Async iterable for providers without a log API. */
export async function* noLogApi(provider: string, hint: string): AsyncIterable<string> {
  yield `[beamhop] ${provider} has no log streaming API usable here. ${hint}`;
}
