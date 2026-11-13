import type { Deployer } from '@beamhop/core';
import type { DeployerOptions } from './common.ts';
import { DigitalOceanDeployer, type DigitalOceanOptions } from './providers/digitalocean.ts';
import { FlyDeployer, type FlyOptions } from './providers/fly.ts';
import { HetznerDeployer, type HetznerOptions } from './providers/hetzner.ts';
import { RailwayDeployer, type RailwayOptions } from './providers/railway.ts';
import { RenderDeployer, type RenderOptions } from './providers/render.ts';

export * from './cloud-init.ts';
export * from './common.ts';
export * from './harness-packages.ts';
export * from './http.ts';
export * from './providers/digitalocean.ts';
export * from './providers/fly.ts';
export * from './providers/hetzner.ts';
export * from './providers/railway.ts';
export * from './providers/render.ts';
export * from './state.ts';
export * from './sync.ts';
export * from './validate.ts';

export const DEPLOY_PROVIDERS = ['hetzner', 'digitalocean', 'fly', 'render', 'railway'] as const;
export type DeployProviderId = (typeof DEPLOY_PROVIDERS)[number];

export interface CreateDeployersOptions extends DeployerOptions {
  hetzner?: Partial<HetznerOptions>;
  digitalocean?: Partial<DigitalOceanOptions>;
  fly?: Partial<FlyOptions>;
  render?: Partial<RenderOptions>;
  railway?: Partial<RailwayOptions>;
}

/** All five deployers sharing one SecretStore, state file and provisioning callback. */
export const createDeployers = (o: CreateDeployersOptions): Record<DeployProviderId, Deployer> => {
  const { hetzner, digitalocean, fly, render, railway, ...base } = o;
  return {
    hetzner: new HetznerDeployer({ ...base, ...hetzner }),
    digitalocean: new DigitalOceanDeployer({ ...base, ...digitalocean }),
    fly: new FlyDeployer({ ...base, ...fly }),
    render: new RenderDeployer({ ...base, ...render }),
    railway: new RailwayDeployer({ ...base, ...railway }),
  };
};

/** Whether a provider token is stored (for `deploy.providers`). Never returns the value. */
export const isConfigured = async (o: Pick<DeployerOptions, 'secrets'>, provider: string): Promise<boolean> =>
  (await o.secrets.get(`deploy.${provider}.token`)) !== undefined;
