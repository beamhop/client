import { z } from 'zod';
import { ChannelTarget, PrincipalId, Slug } from './ids.ts';

// ───────────────────────────── Sandbox policy (§7) ─────────────────────────────

export const SecretBinding = z.object({
  /** Secret name in the beamhop vault/keychain. */
  name: z.string().min(1),
  /** Host the broker injects it for, e.g. "api.github.com". */
  host: z.string().min(1),
  header: z.string().default('Authorization'),
  /** Optional prefix like "Bearer". */
  prefix: z.string().optional(),
});
export type SecretBinding = z.infer<typeof SecretBinding>;

export const SandboxPolicy = z.object({
  fs: z
    .object({
      /** Extra read-only paths (mounts are added automatically). */
      read: z.array(z.string()).default([]),
      /** Extra writable paths (mounts with mode rw are added automatically). */
      write: z.array(z.string()).default([]),
      /** Always denied, even if inside a mount. */
      deny: z.array(z.string()).default([]),
    })
    .default({ read: [], write: [], deny: [] }),
  net: z
    .object({
      /** Domain allowlist; supports leading "*." wildcards. */
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
      denyPrivateIps: z.boolean().default(true),
    })
    .default({ allow: [], deny: [], denyPrivateIps: true }),
  secrets: z.array(SecretBinding).default([]),
  env: z.object({ passthrough: z.array(z.string()).default(['PATH', 'LANG', 'TERM', 'HOME']) }).default({
    passthrough: ['PATH', 'LANG', 'TERM', 'HOME'],
  }),
  proc: z
    .object({
      maxSessionMinutes: z.number().int().positive().default(60),
    })
    .default({ maxSessionMinutes: 60 }),
  /** Learning mode: run permissively-but-logged and collect violations to suggest rules. */
  learning: z.boolean().default(false),
});
export type SandboxPolicy = z.infer<typeof SandboxPolicy>;

/** Paths that are always denied for reading inside any sandbox (§6/§7). */
export const ALWAYS_DENY_READ = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.config/gh',
  '~/.config/gcloud',
  '~/.azure',
  '~/.kube',
  '~/.docker/config.json',
  '~/.netrc',
  '~/.npmrc',
  '~/.beamhop',
  '~/.config/beamhop',
  '~/Library/Keychains',
  '~/Library/Application Support/Google/Chrome',
  '~/Library/Application Support/Firefox',
  '~/.mozilla',
  '~/.config/google-chrome',
  '~/.config/chromium',
  '~/AppData/Roaming/Mozilla',
  '~/AppData/Local/Google/Chrome',
] as const;

export const SandboxProfileName = z.enum(['strict', 'workspace', 'custom']);
export type SandboxProfileName = z.infer<typeof SandboxProfileName>;

// ───────────────────────────── Roles & authz (§6) ─────────────────────────────

export const BUILTIN_ROLES = ['owner', 'admin', 'user', 'viewer', 'agent'] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];
export const RoleName = z.string().regex(/^[a-z][a-z0-9-]*$/);
export type RoleName = z.infer<typeof RoleName>;

export const PermissionMode = z.enum(['read-only', 'plan', 'ask', 'auto']);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const Budget = z.object({
  dailyUsd: z.number().nonnegative().optional(),
  dailyTokens: z.number().int().nonnegative().optional(),
  perSessionMinutes: z.number().int().positive().optional(),
  messagesPerMinute: z.number().int().positive().optional(),
});
export type Budget = z.infer<typeof Budget>;

export const RoleDef = z.object({
  name: RoleName,
  description: z.string().default(''),
  /** Can this role command the agent at all (vs. only being visible in the channel)? */
  canPrompt: z.boolean(),
  permissionMode: PermissionMode,
  sandboxProfile: SandboxProfileName,
  /** Tool name glob patterns. Empty allow = all tools allowed by harness+mode. */
  tools: z.object({ allow: z.array(z.string()).default([]), deny: z.array(z.string()).default([]) }).default({
    allow: [],
    deny: [],
  }),
  /** Tool patterns that always require an owner approval when used by this role. */
  requireApproval: z.array(z.string()).default([]),
  /** Which in-channel commands this role may use (without leading slash). */
  commands: z.array(z.string()).default([]),
  /** May switch model/harness/mode via commands. */
  canReconfigure: z.boolean().default(false),
  /** Can approve/deny pending approvals. */
  canApprove: z.boolean().default(false),
  /** Outbound DLP: block vs. redact vs. warn on detected secrets. */
  dlp: z.enum(['block', 'redact', 'warn']).default('redact'),
  budget: Budget.default({}),
});
export type RoleDef = z.infer<typeof RoleDef>;

// ───────────────────────────── Agent (§6A.1) ─────────────────────────────

export const Mount = z.object({
  path: z.string().min(1),
  mode: z.enum(['ro', 'rw']).default('ro'),
  /** Non-git rw mounts take a write lock unless this is set (§6A.5). */
  parallelUnsafe: z.boolean().default(false),
});
export type Mount = z.infer<typeof Mount>;

export const Trigger = z.enum(['dm', 'mention', 'reply', 'command', 'all']);
export type Trigger = z.infer<typeof Trigger>;

export const Membership = z.object({
  /** Where the agent participates, e.g. "nostr:dm", "mybot:group/-100123". */
  target: ChannelTarget,
  defaultRole: RoleName.default('viewer'),
  triggers: z.array(Trigger).default(['dm', 'mention', 'reply']),
  /** Set when the agent was kicked/removed: membership is gone and never auto-rejoined (§7A). */
  revokedAt: z.string().optional(),
});
export type Membership = z.infer<typeof Membership>;

export const Route = z.object({
  from: ChannelTarget,
  to: ChannelTarget,
});
export type Route = z.infer<typeof Route>;

export const MeshConfig = z.object({
  allow: z.array(z.string()).default([]),
  block: z.array(z.string()).default([]),
  maxTurnsPerThread: z.number().int().positive().default(6),
  maxHops: z.number().int().positive().default(3),
  perPeerBudget: Budget.default({ dailyTokens: 200_000 }),
  acceptJobs: z.array(z.number().int()).default([]),
});
export type MeshConfig = z.infer<typeof MeshConfig>;

export const AgentConfig = z.object({
  name: Slug,
  displayName: z.string().optional(),
  description: z.string().default(''),
  /** Harness id from discovery, e.g. "claude", "codex", "opencode", "pi", "acp:<cmd-id>". */
  harness: z.string().min(1),
  model: z.string().default('default'),
  mounts: z.array(Mount).default([]),
  sandbox: z
    .object({ profile: SandboxProfileName.default('workspace'), policy: SandboxPolicy.optional() })
    .default({ profile: 'workspace' }),
  identity: z
    .object({
      /** Keychain ref for the agent's nostr secret key. */
      nostrKeyRef: z.string().optional(),
      npub: z.string().optional(),
      nip05: z.string().optional(),
    })
    .default({}),
  public: z.boolean().default(false),
  memberships: z.array(Membership).default([]),
  routes: z.array(Route).default([]),
  /** Explicit role grants for this agent: principal → role. Owners are global (see BeamhopConfig.owners). */
  grants: z.record(z.string(), RoleName).default({}),
  concurrency: z.object({ maxSessions: z.number().int().positive().default(3) }).default({ maxSessions: 3 }),
  budgets: Budget.default({ dailyUsd: 5 }),
  sessionIdleMinutes: z.number().int().positive().default(120),
  approvalTimeoutMinutes: z.number().int().positive().default(15),
  mesh: MeshConfig.default({
    allow: [],
    block: [],
    maxTurnsPerThread: 6,
    maxHops: 3,
    perPeerBudget: { dailyTokens: 200_000 },
    acceptJobs: [],
  }),
  retention: z
    .object({
      transcriptDays: z.number().int().positive().default(30),
      auditDays: z.number().int().positive().default(365),
    })
    .default({ transcriptDays: 30, auditDays: 365 }),
  /** Which preset this agent was created from, informational. */
  preset: z.string().optional(),
  /** Cloud harness auth choice (§7). */
  harnessAuth: z.enum(['api-key', 'subscription']).default('api-key'),
});
export type AgentConfig = z.infer<typeof AgentConfig>;
export type AgentConfigInput = z.input<typeof AgentConfig>;

// ───────────────────────────── Channels (§5) ─────────────────────────────

export const ChannelConfig = z.object({
  name: Slug,
  provider: z.string().min(1),
  /** Non-secret provider settings (relay urls, workspace id...). Secrets live in the vault. */
  settings: z.record(z.string(), z.unknown()).default({}),
  /** Names of vault secrets this channel uses. */
  secretRefs: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
});
export type ChannelConfig = z.infer<typeof ChannelConfig>;

// ───────────────────────────── Schedules (§6A.4) ─────────────────────────────

export const ScheduleConfig = z.object({
  id: z.string(),
  agent: Slug,
  kind: z.enum(['cron', 'webhook', 'file-change', 'nostr-event']),
  /** cron expr | webhook path | glob within a mount | JSON nostr filter */
  spec: z.string().min(1),
  timezone: z.string().default('UTC'),
  prompt: z.string().min(1),
  postTo: ChannelTarget.optional(),
  /** Principal whose role/budget applies. */
  owner: PrincipalId,
  enabled: z.boolean().default(true),
  paused: z.boolean().default(false),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfig>;

// ───────────────────────────── Global config ─────────────────────────────

export const BeamhopConfig = z.object({
  version: z.literal(1).default(1),
  /** Owner principals (multiple owners supported, §6). */
  owners: z.array(PrincipalId).default([]),
  /** Linked identities: personId → principals. */
  people: z.record(z.string(), z.array(PrincipalId)).default({}),
  /** Global role grants (apply to all agents unless overridden). */
  grants: z.record(z.string(), RoleName).default({}),
  roles: z.array(RoleDef).default([]),
  approvals: z.object({ quorum: z.number().int().positive().default(1) }).default({ quorum: 1 }),
  nostr: z
    .object({
      relays: z
        .array(z.string())
        .default(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']),
      ownerNpub: z.string().optional(),
    })
    .default({ relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'] }),
  api: z
    .object({ port: z.number().int().default(7878), host: z.string().default('127.0.0.1') })
    .default({ port: 7878, host: '127.0.0.1' }),
  panic: z
    .object({ active: z.boolean().default(false), at: z.string().optional() })
    .default({ active: false }),
  updates: z
    .object({ catalogAuto: z.boolean().default(true), appPrompt: z.boolean().default(true) })
    .default({
      catalogAuto: true,
      appPrompt: true,
    }),
});
export type BeamhopConfig = z.infer<typeof BeamhopConfig>;
