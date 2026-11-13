/**
 * Plugin registry: channels, harnesses, deployers and optional capability providers.
 * Built-in plugins are listed in `BUILTIN_PLUGINS`; adding a package is one line there.
 */
import type {
  ChannelPlugin,
  Deployer,
  HarnessDetection,
  HarnessPlugin,
  Logger,
  SecretStore,
} from '@beamhop/core';

/** Harness discovery (catalog + probes). `@beamhop/harness-discovery` provides one. */
export interface HarnessDiscovery {
  scan(): Promise<HarnessDetection[]>;
}

/** Factory for user-added generic ACP harnesses (`harness.add`). */
export type AcpHarnessFactory = (def: { id: string; command: string; args: string[] }) => HarnessPlugin;

export interface PluginRegistryInit {
  channels?: ChannelPlugin[];
  harnesses?: HarnessPlugin[];
  deployers?: Deployer[];
  discovery?: HarnessDiscovery;
  acpFactory?: AcpHarnessFactory;
}

export class PluginRegistry {
  readonly channels = new Map<string, ChannelPlugin>();
  readonly harnesses = new Map<string, HarnessPlugin>();
  readonly deployers = new Map<string, Deployer>();
  discovery: HarnessDiscovery | undefined;
  acpFactory: AcpHarnessFactory | undefined;

  constructor(init: PluginRegistryInit = {}) {
    for (const c of init.channels ?? []) this.addChannel(c);
    for (const h of init.harnesses ?? []) this.addHarness(h);
    for (const d of init.deployers ?? []) this.addDeployer(d);
    this.discovery = init.discovery;
    this.acpFactory = init.acpFactory;
  }
  addChannel(p: ChannelPlugin): this {
    this.channels.set(p.id, p);
    return this;
  }
  addHarness(p: HarnessPlugin): this {
    this.harnesses.set(p.id, p);
    return this;
  }
  addDeployer(d: Deployer): this {
    this.deployers.set(d.id, d);
    return this;
  }
  channel(id: string): ChannelPlugin | undefined {
    return this.channels.get(id);
  }
  /** Exact id, else the harness whose id is a prefix family ("acp:foo" → "acp:foo"). */
  harness(id: string): HarnessPlugin | undefined {
    return this.harnesses.get(id);
  }
}

export interface BuiltinContext {
  registry: PluginRegistry;
  secrets: SecretStore;
  log: Logger;
  /** Supplies provisioning info for deployers (owner npub etc.). */
  provisioning: () => Promise<{
    ownerNpub: string;
    provisioningPubkey: string;
    beamhopVersion: string;
  }>;
}

type Loader = (mod: Record<string, unknown>, ctx: BuiltinContext) => void | Promise<void>;

/**
 * Optional built-in packages, imported lazily. A missing package is skipped silently, so the
 * daemon works with any subset installed. Add new channels/harnesses/deployers here.
 */
export const BUILTIN_PLUGINS: { module: string; load: Loader }[] = [
  {
    module: '@beamhop/channel-nostr',
    load: async (m, c) => {
      const { proxyWebSocket } = await import('./net.ts');
      const ws = proxyWebSocket();
      const create = m.createNostrChannel as (deps: unknown) => ChannelPlugin;
      c.registry.addChannel(ws ? create({ WebSocket: ws }) : (m.nostrChannel as ChannelPlugin));
    },
  },
  {
    module: '@beamhop/channel-telegram',
    load: (m, c) => void c.registry.addChannel(m.telegramPlugin as ChannelPlugin),
  },
  {
    module: '@beamhop/channel-slack',
    load: (m, c) => void c.registry.addChannel(m.slackPlugin as ChannelPlugin),
  },
  {
    module: '@beamhop/channel-discord',
    load: (m, c) => void c.registry.addChannel(m.discordPlugin as ChannelPlugin),
  },
  {
    module: '@beamhop/deploy',
    load: (m, c) => {
      const create = m.createDeployers as (o: unknown) => Record<string, Deployer>;
      const all = create({ secrets: c.secrets, log: c.log, provisioning: () => c.provisioning() });
      for (const d of Object.values(all)) c.registry.addDeployer(d);
    },
  },
  // Harness adapters (§3.2). ACP covers every catalog entry whose preferred protocol is ACP.
  {
    module: '@beamhop/harness-acp',
    load: (m, c) => {
      const all = (m.acpHarnessesFromCatalog as (cat?: unknown, o?: unknown) => HarnessPlugin[])(undefined, {
        log: c.log,
      });
      for (const h of all) c.registry.addHarness(h);
      const custom = m.customAcpHarness as (o: {
        id: string;
        command: string;
        args?: string[];
        log?: Logger;
      }) => HarnessPlugin;
      c.registry.acpFactory = (def) => custom({ ...def, log: c.log });
    },
  },
  {
    module: '@beamhop/harness-claude',
    load: (m, c) =>
      void c.registry.addHarness((m.claudeHarness as (o: unknown) => HarnessPlugin)({ log: c.log })),
  },
  {
    module: '@beamhop/harness-codex',
    load: (m, c) =>
      void c.registry.addHarness(
        (m.codexHarness as (o: unknown) => HarnessPlugin)({ log: c.log, mode: 'auto' }),
      ),
  },
  {
    module: '@beamhop/harness-pi',
    load: (m, c) =>
      void c.registry.addHarness((m.piHarness as (o: unknown) => HarnessPlugin)({ log: c.log })),
  },
  {
    module: '@beamhop/harness-discovery',
    load: (m, c) => {
      const scan = m.scanHarnesses as () => Promise<HarnessDetection[]>;
      c.registry.discovery = { scan: () => scan() };
    },
  },
];

const isMissing = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException)?.code;
  return (
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'MODULE_NOT_FOUND' ||
    code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ||
    /Cannot find (module|package)|Failed to load url/.test(String((e as Error)?.message ?? e))
  );
};

/** Import every available built-in plugin into the registry. */
export const loadBuiltinPlugins = async (ctx: BuiltinContext): Promise<string[]> => {
  const loaded: string[] = [];
  for (const { module, load } of BUILTIN_PLUGINS) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(/* @vite-ignore */ module)) as Record<string, unknown>;
    } catch (e) {
      if (!isMissing(e)) ctx.log.warn('plugin failed to load', { module, error: String(e) });
      continue;
    }
    try {
      await load(mod, ctx);
      loaded.push(module);
    } catch (e) {
      ctx.log.warn('plugin failed to register', { module, error: String(e) });
    }
  }
  return loaded;
};
