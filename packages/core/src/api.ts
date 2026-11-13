/**
 * The beamhop API contract (§2). One zod-typed JSON-RPC surface shared by:
 *  - the CLI (local socket / HTTP),
 *  - the PWA (localhost WebSocket, or encrypted Nostr control events when hosted),
 *  - remote daemons (Nostr control plane).
 *
 * Every method has `params` and `result` schemas. Servers validate params; clients may validate results.
 */
import { z } from 'zod';
import { AgentConfig, ChannelConfig, Membership, RoleDef, SandboxPolicy, ScheduleConfig } from './config.ts';

// ───────────────────────────── Entities ─────────────────────────────

export const AgentStatus = z.enum(['stopped', 'starting', 'idle', 'busy', 'error', 'paused']);
export const AgentView = z.object({
  config: AgentConfig,
  status: AgentStatus,
  activeSessions: z.number().int(),
  lastActivityAt: z.string().optional(),
  usageToday: z.object({ usd: z.number(), tokens: z.number(), minutes: z.number() }),
  error: z.string().optional(),
  location: z.object({ kind: z.enum(['local', 'cloud']), provider: z.string().optional() }),
});
export type AgentView = z.infer<typeof AgentView>;

export const HarnessView = z.object({
  id: z.string(),
  displayName: z.string(),
  command: z.string(),
  version: z.string().optional(),
  path: z.string().optional(),
  status: z.enum(['ready', 'needs-login', 'unsupported-version', 'not-installed', 'error']),
  protocol: z.string(),
  message: z.string().optional(),
  install: z
    .object({
      npm: z.string().optional(),
      brew: z.string().optional(),
      winget: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
});
export type HarnessView = z.infer<typeof HarnessView>;

export const ChannelView = z.object({
  config: ChannelConfig,
  status: z.enum(['connected', 'connecting', 'disconnected', 'error', 'disabled']),
  self: z
    .object({ principal: z.string(), displayName: z.string(), handle: z.string().optional() })
    .optional(),
  error: z.string().optional(),
});
export type ChannelView = z.infer<typeof ChannelView>;

export const SessionEventView = z.object({
  seq: z.number().int(),
  at: z.string(),
  kind: z.enum([
    'user',
    'assistant',
    'tool_call',
    'tool_result',
    'permission',
    'progress',
    'system',
    'error',
    'usage',
  ]),
  /** Who said it (for user messages). */
  from: z
    .object({ principal: z.string(), displayName: z.string().optional(), role: z.string().optional() })
    .optional(),
  text: z.string().optional(),
  tool: z
    .object({
      id: z.string(),
      name: z.string(),
      title: z.string().optional(),
      input: z.unknown().optional(),
      output: z.string().optional(),
      ok: z.boolean().optional(),
      diff: z.string().optional(),
    })
    .optional(),
  approvalId: z.string().optional(),
});
export type SessionEventView = z.infer<typeof SessionEventView>;

export const SessionView = z.object({
  id: z.string(),
  agent: z.string(),
  channel: z.string(),
  conversationId: z.string(),
  threadId: z.string(),
  title: z.string(),
  status: z.enum(['running', 'idle', 'queued', 'ended', 'error']),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  worktree: z.object({ path: z.string(), branch: z.string() }).optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), usd: z.number() }),
});
export type SessionView = z.infer<typeof SessionView>;

export const ApprovalView = z.object({
  id: z.string(),
  agent: z.string(),
  sessionId: z.string(),
  requestedBy: z.object({ principal: z.string(), displayName: z.string().optional(), role: z.string() }),
  tool: z.string(),
  title: z.string(),
  input: z.unknown(),
  /** Short human risk summary for the card. */
  risk: z.enum(['low', 'medium', 'high']),
  createdAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  kind: z.enum(['tool', 'access-request', 'policy-suggestion', 'deploy']).default('tool'),
  /** N-of-M approvals (config `approvals.quorum` > 1): approvals needed out of the eligible pool. */
  quorum: z.object({ needed: z.number().int(), pool: z.number().int() }).optional(),
  /** Votes cast so far (multi-owner). `by` is the approver's display name or principal. */
  votes: z.array(z.object({ by: z.string(), allow: z.boolean(), at: z.string() })).optional(),
});
export type ApprovalView = z.infer<typeof ApprovalView>;

export const AuditEvent = z.object({
  id: z.string(),
  at: z.string(),
  agent: z.string().optional(),
  actor: z.string(),
  type: z.string(),
  severity: z.enum(['info', 'warn', 'security']),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const UsageRow = z.object({
  day: z.string(),
  agent: z.string(),
  channel: z.string().optional(),
  peer: z.string().optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  usd: z.number(),
  minutes: z.number(),
});
export type UsageRow = z.infer<typeof UsageRow>;

export const DeviceView = z.object({
  id: z.string(),
  name: z.string(),
  pubkey: z.string(),
  pairedAt: z.string(),
  lastSeenAt: z.string().optional(),
  pushEnabled: z.boolean(),
});
export type DeviceView = z.infer<typeof DeviceView>;

export const DoctorCheck = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['ok', 'warn', 'fail', 'skip']),
  message: z.string(),
  fix: z.string().optional(),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

export const DeploymentView = z.object({
  id: z.string(),
  provider: z.string(),
  agent: z.string(),
  status: z.enum(['provisioning', 'running', 'stopped', 'error', 'destroyed']),
  region: z.string().optional(),
  size: z.string().optional(),
  createdAt: z.string(),
  monthlyCostUsd: z.number().optional(),
});
export type DeploymentView = z.infer<typeof DeploymentView>;

export const PolicySuggestion = z.object({
  id: z.string(),
  agent: z.string(),
  kind: z.enum(['net.allow', 'fs.read', 'fs.write']),
  value: z.string(),
  count: z.number().int(),
  lastSeenAt: z.string(),
});
export type PolicySuggestion = z.infer<typeof PolicySuggestion>;

export const WizardView = z.object({
  provider: z.string(),
  displayName: z.string(),
  steps: z.array(z.unknown()),
});

// ───────────────────────────── Methods ─────────────────────────────

const empty = z.object({}).default({});
const ok = z.object({ ok: z.literal(true) });
const byName = z.object({ name: z.string() });

export const methods = {
  'system.status': {
    params: empty,
    result: z.object({
      version: z.string(),
      uptimeSec: z.number(),
      panic: z.boolean(),
      agents: z.number(),
      channels: z.number(),
      pendingApprovals: z.number(),
      owner: z.object({ npub: z.string().optional() }),
      home: z.string(),
    }),
  },
  'system.doctor': { params: empty, result: z.object({ checks: z.array(DoctorCheck) }) },
  'system.panic': { params: z.object({ reason: z.string().optional() }).default({}), result: ok },
  'system.resume': { params: empty, result: ok },

  'agent.list': { params: empty, result: z.object({ agents: z.array(AgentView) }) },
  'agent.get': { params: byName, result: AgentView },
  /** `config` is validated server-side against AgentConfig after merging the preset. */
  'agent.create': {
    params: z.object({ config: z.record(z.string(), z.unknown()), preset: z.string().optional() }),
    result: AgentView,
  },
  'agent.update': {
    params: z.object({ name: z.string(), patch: z.record(z.string(), z.unknown()) }),
    result: AgentView,
  },
  'agent.delete': { params: byName, result: ok },
  'agent.start': { params: byName, result: AgentView },
  'agent.stop': {
    params: z.object({ name: z.string(), hard: z.boolean().default(false) }),
    result: AgentView,
  },
  'agent.clone': { params: z.object({ name: z.string(), newName: z.string() }), result: AgentView },
  'agent.presets': {
    params: empty,
    result: z.object({
      presets: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          description: z.string(),
          config: z.record(z.string(), z.unknown()),
        }),
      ),
    }),
  },
  'agent.instructions': {
    params: byName,
    result: z.object({
      files: z.array(z.object({ path: z.string(), harness: z.string(), content: z.string() })),
    }),
  },

  'harness.scan': { params: empty, result: z.object({ harnesses: z.array(HarnessView) }) },
  'harness.list': { params: empty, result: z.object({ harnesses: z.array(HarnessView) }) },
  'harness.add': {
    params: z.object({ id: z.string(), command: z.string(), args: z.array(z.string()).default([]) }),
    result: HarnessView,
  },

  'channel.providers': { params: empty, result: z.object({ providers: z.array(WizardView) }) },
  'channel.list': { params: empty, result: z.object({ channels: z.array(ChannelView) }) },
  'channel.validate': {
    params: z.object({
      provider: z.string(),
      values: z.record(z.string(), z.unknown()),
      secrets: z.record(z.string(), z.string()),
    }),
    result: z.object({
      ok: z.boolean(),
      message: z.string(),
      identity: z
        .object({ name: z.string(), handle: z.string().optional(), avatarUrl: z.string().optional() })
        .optional(),
    }),
  },
  'channel.add': {
    params: z.object({
      name: z.string(),
      provider: z.string(),
      values: z.record(z.string(), z.unknown()),
      secrets: z.record(z.string(), z.string()),
    }),
    result: ChannelView,
  },
  'channel.remove': { params: byName, result: ok },
  'channel.pair': {
    params: byName,
    result: z.object({ code: z.string(), expiresAt: z.string(), instructions: z.string() }),
  },

  'membership.join': { params: z.object({ agent: z.string(), membership: Membership }), result: AgentView },
  'membership.leave': { params: z.object({ agent: z.string(), target: z.string() }), result: AgentView },

  'session.list': {
    params: z.object({ agent: z.string().optional() }).default({}),
    result: z.object({ sessions: z.array(SessionView) }),
  },
  'session.events': {
    params: z.object({ id: z.string(), afterSeq: z.number().int().default(0) }),
    result: z.object({ events: z.array(SessionEventView) }),
  },
  'session.send': { params: z.object({ id: z.string(), text: z.string() }), result: ok },
  'session.start': {
    params: z.object({ agent: z.string(), text: z.string(), title: z.string().optional() }),
    result: SessionView,
  },
  'session.stop': { params: z.object({ id: z.string() }), result: ok },

  'approval.list': {
    params: z
      .object({ status: z.enum(['pending', 'all']).default('pending') })
      .default({ status: 'pending' }),
    result: z.object({ approvals: z.array(ApprovalView) }),
  },
  'approval.decide': {
    params: z.object({
      id: z.string(),
      allow: z.boolean(),
      always: z.boolean().default(false),
      grantRole: z.string().optional(),
      /** Allow for the rest of this session (until it ends) instead of once. */
      session: z.boolean().optional(),
      /** With `always`: the exact policy value to add, e.g. `*.npmjs.org` instead of the host. */
      rule: z.string().optional(),
      /** With a deny: a short reason passed back to the agent. */
      reason: z.string().max(500).optional(),
    }),
    result: ApprovalView,
  },
  'approval.undo': { params: z.object({ id: z.string() }), result: ApprovalView },

  'role.list': {
    params: empty,
    result: z.object({ roles: z.array(RoleDef), grants: z.record(z.string(), z.string()) }),
  },
  'role.grant': {
    params: z.object({ principal: z.string(), role: z.string(), agent: z.string().optional() }),
    result: ok,
  },
  'role.revoke': { params: z.object({ principal: z.string(), agent: z.string().optional() }), result: ok },
  'principal.link': { params: z.object({ person: z.string(), principal: z.string() }), result: ok },
  'owner.add': { params: z.object({ principal: z.string() }), result: ok },
  'owner.remove': { params: z.object({ principal: z.string() }), result: ok },

  'policy.get': { params: byName, result: z.object({ profile: z.string(), effective: SandboxPolicy }) },
  'policy.set': {
    params: z.object({ name: z.string(), profile: z.string(), policy: SandboxPolicy.optional() }),
    result: ok,
  },
  'policy.suggestions': {
    params: z.object({ name: z.string().optional() }).default({}),
    result: z.object({ suggestions: z.array(PolicySuggestion) }),
  },
  'policy.applySuggestion': {
    /** `value` overrides the suggested value when accepting (e.g. `*.npmjs.org` for a host). */
    params: z.object({ id: z.string(), accept: z.boolean(), value: z.string().optional() }),
    result: ok,
  },

  'secret.list': {
    params: empty,
    result: z.object({
      secrets: z.array(z.object({ name: z.string(), updatedAt: z.string().optional() })),
      backend: z.string(),
    }),
  },
  'secret.set': { params: z.object({ name: z.string(), value: z.string() }), result: ok },
  'secret.delete': { params: byName, result: ok },

  'schedule.list': {
    params: z.object({ agent: z.string().optional() }).default({}),
    result: z.object({ schedules: z.array(ScheduleConfig) }),
  },
  /** For webhook schedules the result carries the hook URL and its secret (shown once). */
  'schedule.add': {
    params: ScheduleConfig.omit({ id: true }),
    result: ScheduleConfig.extend({ webhook: z.object({ url: z.string(), secret: z.string() }).optional() }),
  },
  'schedule.update': {
    params: z.object({ id: z.string(), patch: z.record(z.string(), z.unknown()) }),
    result: ScheduleConfig,
  },
  'schedule.remove': { params: z.object({ id: z.string() }), result: ok },
  'schedule.run': { params: z.object({ id: z.string() }), result: ok },

  'deploy.providers': {
    params: empty,
    result: z.object({
      providers: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          kind: z.enum(['vps', 'paas']),
          configured: z.boolean(),
        }),
      ),
    }),
  },
  'deploy.options': {
    params: z.object({ provider: z.string() }),
    result: z.object({
      sizes: z.array(z.object({ id: z.string(), label: z.string(), monthlyUsd: z.number() })),
      regions: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
  },
  'deploy.plan': {
    params: z.object({
      agent: z.string(),
      provider: z.string(),
      region: z.string().optional(),
      size: z.string().optional(),
      mode: z.enum(['move', 'new']),
    }),
    result: z.object({
      provider: z.string(),
      actions: z.array(z.object({ op: z.string(), resource: z.string(), detail: z.string() })),
      monthlyCostUsd: z.number(),
      warnings: z.array(z.string()),
    }),
  },
  'deploy.apply': {
    params: z.object({
      agent: z.string(),
      provider: z.string(),
      region: z.string().optional(),
      size: z.string().optional(),
      mode: z.enum(['move', 'new']),
    }),
    result: DeploymentView,
  },
  'deploy.list': { params: empty, result: z.object({ deployments: z.array(DeploymentView) }) },
  'deploy.destroy': { params: z.object({ id: z.string() }), result: ok },

  'audit.query': {
    params: z
      .object({
        agent: z.string().optional(),
        severity: z.enum(['info', 'warn', 'security']).optional(),
        limit: z.number().int().max(1000).default(200),
        before: z.string().optional(),
      })
      .default({ limit: 200 }),
    result: z.object({ events: z.array(AuditEvent) }),
  },
  'usage.query': {
    params: z
      .object({ days: z.number().int().max(365).default(14), agent: z.string().optional() })
      .default({ days: 14 }),
    result: z.object({ rows: z.array(UsageRow) }),
  },

  'device.list': { params: empty, result: z.object({ devices: z.array(DeviceView) }) },
  'device.pairStart': {
    params: z.object({ name: z.string().default('New device') }).default({ name: 'New device' }),
    result: z.object({ uri: z.string(), code: z.string(), expiresAt: z.string() }),
  },
  'device.pairComplete': {
    params: z.object({ code: z.string(), pubkey: z.string(), name: z.string() }),
    result: DeviceView,
  },
  'device.remove': { params: z.object({ id: z.string() }), result: ok },
  'device.pushSubscribe': { params: z.object({ id: z.string(), subscription: z.unknown() }), result: ok },

  'identity.get': {
    params: empty,
    result: z.object({
      npub: z.string().optional(),
      agents: z.array(
        z.object({ name: z.string(), npub: z.string().optional(), nip05: z.string().optional() }),
      ),
    }),
  },
  'identity.nip05': {
    params: z.object({ domain: z.string(), names: z.record(z.string(), z.string()).optional() }),
    result: z.object({ json: z.string(), snippets: z.record(z.string(), z.string()) }),
  },

  'data.export': {
    params: z.object({ agent: z.string().optional() }).default({}),
    result: z.object({ path: z.string() }),
  },
  'data.purge': {
    params: z.object({ agent: z.string().optional(), before: z.string().optional() }).default({}),
    result: z.object({ deleted: z.number() }),
  },
} as const;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type Params<M extends MethodName> = z.input<Methods[M]['params']>;
export type ParsedParams<M extends MethodName> = z.output<Methods[M]['params']>;
export type Result<M extends MethodName> = z.output<Methods[M]['result']>;

export const isMethod = (m: string): m is MethodName => Object.hasOwn(methods, m);

// ───────────────────────────── Push events (server → client) ─────────────────────────────

export type ServerEvent =
  | { type: 'agent.updated'; agent: AgentView }
  | { type: 'session.updated'; session: SessionView }
  | { type: 'session.event'; sessionId: string; event: SessionEventView }
  | { type: 'approval.created'; approval: ApprovalView }
  | { type: 'approval.updated'; approval: ApprovalView }
  | { type: 'channel.updated'; channel: ChannelView }
  | { type: 'audit'; event: AuditEvent }
  | { type: 'panic'; active: boolean };

// ───────────────────────────── JSON-RPC envelope ─────────────────────────────

export const RpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number; result: unknown }
  | { jsonrpc: '2.0'; id: string | number; error: { code: number; message: string; data?: unknown } };

export type RpcNotification = { jsonrpc: '2.0'; method: 'event'; params: ServerEvent };
