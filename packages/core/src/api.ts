/**
 * The beamhop API contract (§2). One zod-typed JSON-RPC surface shared by:
 *  - the CLI (local socket / HTTP),
 *  - the PWA (localhost WebSocket, or encrypted Nostr control events when hosted),
 *  - remote daemons (Nostr control plane).
 *
 * Every method has `params` and `result` schemas. Servers validate params; clients may validate results.
 */
import { z } from 'zod';
import {
  AgentConfig,
  AlertRules,
  AlertRulesPatch,
  ChannelConfig,
  Membership,
  RoleDef,
  SandboxPolicy,
  ScheduleConfig,
} from './config.ts';

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
  /**
   * What `harness.install` would do on this computer: the first method that applies (the harness's own
   * installer, Homebrew, npm, winget), or `none` (only `install.url` to follow by hand).
   */
  installPlan: z
    .object({
      method: z.enum(['native', 'brew', 'npm', 'winget', 'none']),
      /** e.g. "Claude Code installer", "Homebrew", "npm". */
      label: z.string(),
      /** What runs, for display ("Show details", the CLI). Empty for `none`. */
      command: z.array(z.string()),
      /** `none`: why nothing applies here ("Needs Homebrew or Node.js; neither was found."). */
      reason: z.string().optional(),
      /** Other methods that would also work here, best first. */
      alternatives: z.array(z.enum(['native', 'brew', 'npm', 'winget'])).default([]),
    })
    .optional(),
  /** beamhop installed it (under <home>/harnesses); `harness.update` and uninstall manage only these + brew. */
  managed: z.boolean().optional(),
  /** The harness's own login can run without a terminal (`harness.loginFlow`). */
  loginFlow: z.object({ kind: z.enum(['browser', 'device-code']) }).optional(),
  /**
   * Login for sandboxed agents (your own login is not usable inside the sandbox). `unchecked`: a
   * credential is stored but not verified yet; `unmanaged`: beamhop does not manage this harness's login.
   */
  login: z
    .object({
      status: z.enum(['logged-in', 'logged-out', 'invalid', 'unchecked', 'unmanaged']),
      /** The method in use (first one whose secret is set). */
      method: z.string().optional(),
      checkedAt: z.string().optional(),
      message: z.string().optional(),
      methods: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          /**
           * broker: the agent never sees it. env: the agent can read it. home: a subscription sign-in
           * (ChatGPT, Google…) run with `harness.loginFlow { method }`; the agent can read it.
           */
          kind: z.enum(['broker', 'env', 'home']),
          secret: z.string(),
          set: z.boolean(),
          hint: z.string().optional(),
          importFrom: z.string().optional(),
        }),
      ),
    })
    .optional(),
});
export type HarnessView = z.infer<typeof HarnessView>;

export const HarnessJobStep = z.enum([
  'resolving',
  'downloading',
  'verifying',
  'installing',
  'checking',
  'waiting-browser',
  'done',
  'failed',
  'cancelled',
]);
export type HarnessJobStep = z.infer<typeof HarnessJobStep>;

/**
 * A harness install, update or login running in the daemon. Clients poll `harness.job.get` (the CLI
 * talks plain HTTP; the PWA uses the same call), so a job survives a reload or a CLI Ctrl-C.
 */
export const HarnessJob = z.object({
  id: z.string(),
  harness: z.string(),
  /** The harness's display name ("Gemini CLI"). */
  displayName: z.string().optional(),
  kind: z.enum(['install', 'update', 'login']),
  method: z.enum(['native', 'brew', 'npm', 'winget', 'flow']).optional(),
  step: HarnessJobStep,
  /** Plain-language status or error ("Homebrew is busy with another install. Try again in a minute."). */
  message: z.string().optional(),
  /** Login: the page to open (the daemon opens it when asked; headless clients print it). */
  url: z.string().optional(),
  /** Login: a device code to enter on that page. */
  code: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  /** Raw output lines so far (fetch them with `harness.job.get` `since`). */
  lines: z.number().int(),
});
export type HarnessJob = z.infer<typeof HarnessJob>;
export const isJobFinished = (j: Pick<HarnessJob, 'step'>): boolean =>
  j.step === 'done' || j.step === 'failed' || j.step === 'cancelled';

/** Package managers the harness catalog lists packages for. */
export type InstallManager = 'npm' | 'brew' | 'winget';

/**
 * The shell command that installs `pkg` with `manager`. The catalog stores package names/ids only
 * (`@google/gemini-cli`, `gemini-cli`, `GitHub.Copilot`); an entry that is already a full command
 * is returned as-is.
 */
export const installCommand = (manager: InstallManager, pkg: string): string => {
  const p = pkg.trim();
  if (!p) return '';
  const prefix = { npm: 'npm i -g ', brew: 'brew install ', winget: 'winget install --id ' }[manager];
  const head = { npm: /^npm\s/, brew: /^brew\s/, winget: /^winget\s/ }[manager];
  if (head.test(p)) return p;
  return manager === 'winget' ? `${prefix}${p} -e` : `${prefix}${p}`;
};

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

export const PairingStatusView = z.object({
  pairingId: z.string(),
  status: z.enum(['waiting', 'awaiting-confirm', 'paired', 'rejected', 'expired']),
  expiresAt: z.string(),
  device: DeviceView.optional(),
  /** 4 words derived from the daemon and device pubkeys; the phone shows the same words. */
  safetyPhrase: z.array(z.string()).optional(),
});
export type PairingStatusView = z.infer<typeof PairingStatusView>;

export const EventTemplateView = z.object({
  kind: z.number().int(),
  created_at: z.number().int(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
});

export const DoctorCheck = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['ok', 'warn', 'fail', 'skip']),
  message: z.string(),
  /** Human-readable fix (may mention a command; shown by the CLI and in "Show details"). */
  fix: z.string().optional(),
  /**
   * A fix beamhop can apply itself (`system.doctorFix`, `beamhop doctor --fix`). `id` names an entry in
   * the daemon's fixed table; clients never send a command. `admin`: needs administrator rights (the
   * daemon asks through the OS prompt; the CLI may run `command` with sudo instead).
   */
  action: z
    .object({
      id: z.string(),
      label: z.string(),
      summary: z.string(),
      admin: z.boolean(),
      /** What runs, for display (and for the CLI's sudo path). */
      command: z.array(z.string()),
    })
    .optional(),
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

/** Web Push notification categories (§9B); each paired device turns them on or off. */
export const PushCategory = z.enum(['approvals', 'budget', 'crash', 'offline', 'security']);
export type PushCategory = z.infer<typeof PushCategory>;
export const PushPrefs = z.record(PushCategory, z.boolean());
export type PushPrefs = z.infer<typeof PushPrefs>;

/** A cloud daemon this daemon controls over the Nostr control plane (§7A panic, §9B heartbeats). */
export const RemoteDaemonView = z.object({
  deployment: z.string(),
  agent: z.string(),
  provider: z.string(),
  /** Control-plane npub of the remote daemon, once it has announced itself. */
  npub: z.string().optional(),
  provisioning: z.enum(['pending', 'done', 'failed']),
  online: z.boolean(),
  lastHeartbeatAt: z.string().optional(),
  /** Remote panic state as last reported by heartbeat. */
  remotePanic: z.boolean().optional(),
  /** Outcome of the last panic/resume fan-out to this remote. */
  command: z
    .object({
      kind: z.enum(['panic', 'resume']),
      state: z.enum(['pending', 'acked', 'failed']),
      at: z.string(),
      error: z.string().optional(),
    })
    .optional(),
});
export type RemoteDaemonView = z.infer<typeof RemoteDaemonView>;

export const PolicySuggestion = z.object({
  id: z.string(),
  agent: z.string(),
  kind: z.enum(['net.allow', 'fs.read', 'fs.write']),
  value: z.string(),
  count: z.number().int(),
  lastSeenAt: z.string(),
});
export type PolicySuggestion = z.infer<typeof PolicySuggestion>;

/** Who the caller of an API request is (`system.whoami`). */
export const WhoamiView = z.object({
  /** The principal the daemon acts for (`local:owner` for local clients and paired devices). */
  principal: z.string(),
  /** Effective global role: `owner` for local clients, paired devices and owner npubs. */
  role: z.string(),
  displayName: z.string().optional(),
  /** Linked person (`BeamhopConfig.people`) the principal belongs to. */
  person: z.string().optional(),
  via: z.enum(['local', 'device', 'nostr']),
  /** The paired device the request came from (Nostr control plane). */
  device: z.object({ id: z.string(), name: z.string() }).optional(),
});
export type WhoamiView = z.infer<typeof WhoamiView>;

/** One directory in `fs.list` (never file contents). `path` uses `~` for the home directory. */
export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  /** The directory is the top of a git work tree. */
  git: z.boolean(),
});
export type FsEntry = z.infer<typeof FsEntry>;

const DeployMountChoice = z.object({
  path: z.string(),
  sync: z.enum(['git-clone', 'rsync', 'mutagen', 'skip']),
});
const HarnessAuth = z.enum(['api-key', 'subscription']);

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
      /** Cloud daemons controlled from here (panic fan-out status, heartbeats). */
      remotes: z.array(RemoteDaemonView).optional(),
    }),
  },
  'system.doctor': { params: empty, result: z.object({ checks: z.array(DoctorCheck) }) },
  /** Who "you" are for this connection (local → owner; a paired device → its owner link). */
  'system.whoami': { params: empty, result: WhoamiView },
  'system.panic': { params: z.object({ reason: z.string().optional() }).default({}), result: ok },
  'system.resume': { params: empty, result: ok },
  /**
   * Apply a doctor fix by its action id (local only). Admin fixes go through the OS prompt (macOS admin
   * dialog, pkexec); `elevate: 'none'` refuses them instead (the CLI then offers sudo itself).
   */
  'system.doctorFix': {
    params: z.object({ id: z.string(), elevate: z.enum(['os-prompt', 'none']).default('os-prompt') }),
    result: z.object({ checks: z.array(DoctorCheck), output: z.string() }),
  },

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

  /**
   * Write a harness instruction file (CLAUDE.md, AGENTS.md, ...) inside one of the agent's rw mounts.
   * `path` is absolute (as returned by `agent.instructions`) or relative to the first rw mount.
   */
  'agent.instructionsWrite': {
    params: z.object({
      name: z.string(),
      path: z.string().min(1),
      content: z.string().max(256 * 1024),
    }),
    result: z.object({ path: z.string(), harness: z.string(), bytes: z.number().int() }),
  },

  'harness.scan': { params: empty, result: z.object({ harnesses: z.array(HarnessView) }) },
  'harness.list': { params: empty, result: z.object({ harnesses: z.array(HarnessView) }) },
  /**
   * Models a harness offers with its current sign-in, asked of the harness itself (it is started briefly
   * in a sandbox, no prompt sent; cached for a few minutes, `refresh` to ask again). `error` when it
   * could not list them (not installed, not signed in, no listing support): type a model id instead.
   */
  'harness.models': {
    params: z.object({ id: z.string(), refresh: z.boolean().default(false) }),
    result: z.object({
      models: z.array(
        z.object({
          id: z.string(),
          label: z.string().optional(),
          description: z.string().optional(),
          isDefault: z.boolean().optional(),
        }),
      ),
      error: z.string().optional(),
    }),
  },
  /** Store a credential for a harness login method (default: its first method), then check it. */
  'harness.login': {
    params: z.object({ id: z.string(), method: z.string().optional(), value: z.string().min(1) }),
    result: HarnessView,
  },
  /** Remove a harness's stored login (one method, or all of them). */
  'harness.logout': {
    params: z.object({ id: z.string(), method: z.string().optional() }),
    result: HarnessView,
  },
  /** Verify the harness's login for real (provider key endpoint, or a sandboxed start). */
  'harness.checkLogin': { params: z.object({ id: z.string() }), result: HarnessView },
  'harness.add': {
    params: z.object({ id: z.string(), command: z.string(), args: z.array(z.string()).default([]) }),
    result: HarnessView,
  },
  /** Install a harness on this computer (local only). Starts a job; poll `harness.job.get`. */
  'harness.install': {
    params: z.object({ id: z.string(), method: z.enum(['native', 'brew', 'npm', 'winget']).optional() }),
    result: HarnessJob,
  },
  /** Update an installed harness the way it was installed (local only). */
  'harness.update': { params: z.object({ id: z.string() }), result: HarnessJob },
  /** Installed harnesses with a newer version available (cached for a day; `refresh` re-checks). */
  'harness.updates': {
    params: z.object({ refresh: z.boolean().default(false) }).default({ refresh: false }),
    result: z.object({
      updates: z.array(
        z.object({
          id: z.string(),
          current: z.string().optional(),
          latest: z.string().optional(),
          available: z.boolean(),
          /** Too old to work (unsupported-version): updating fixes it. */
          required: z.boolean(),
        }),
      ),
    }),
  },
  /**
   * Run the harness's own login without a terminal (local only). `openBrowser`: the daemon opens the
   * sign-in page itself; headless clients pass false and show `job.url` / `job.code`.
   */
  'harness.loginFlow': {
    params: z.object({
      id: z.string(),
      openBrowser: z.boolean().default(true),
      /** A `home` login method to sign in with (default: the harness's own flow, else its first home method). */
      method: z.string().optional(),
    }),
    result: HarnessJob,
  },
  'harness.job.get': {
    params: z.object({ jobId: z.string(), since: z.number().int().min(0).default(0) }),
    result: z.object({ job: HarnessJob, lines: z.array(z.string()), next: z.number().int() }),
  },
  /** Running and recent (last hour) jobs, newest first. */
  'harness.job.list': { params: empty, result: z.object({ jobs: z.array(HarnessJob) }) },
  'harness.job.cancel': { params: z.object({ jobId: z.string() }), result: HarnessJob },

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

  /** Reconnect a channel and mark it enabled. */
  'channel.connect': { params: byName, result: ChannelView },
  /** Disconnect a channel and keep it disabled (across restarts) until `channel.connect`. */
  'channel.disconnect': { params: byName, result: ChannelView },

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
  /**
   * Merge a session's worktree branch into `base` (default: the repo's checked-out branch). Uncommitted
   * worktree changes are committed first. Owner only; the session must not be running.
   */
  'session.merge': {
    params: z.object({
      id: z.string(),
      base: z.string().optional(),
      deleteBranch: z.boolean().default(false),
    }),
    result: z.object({
      branch: z.string(),
      base: z.string(),
      commit: z.string(),
      fastForward: z.boolean(),
    }),
  },
  /**
   * Push a session's worktree branch to `remote` after an owner approval (the push runs when the
   * returned approval settles) and return the provider compare URL to open a PR. Owner only.
   */
  'session.openPr': {
    params: z.object({ id: z.string(), remote: z.string().default('origin'), base: z.string().optional() }),
    result: z.object({
      branch: z.string(),
      base: z.string(),
      remote: z.string(),
      compareUrl: z.string().optional(),
      approval: ApprovalView,
    }),
  },

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

  /** Current approval quorum (N of M owners) and the size of the approver pool. */
  'approval.quorumGet': {
    params: empty,
    result: z.object({ quorum: z.number().int(), approvers: z.number().int() }),
  },
  'approval.quorumSet': {
    params: z.object({ quorum: z.number().int().min(1).max(20) }),
    result: z.object({ quorum: z.number().int(), approvers: z.number().int() }),
  },

  'role.list': {
    params: empty,
    result: z.object({ roles: z.array(RoleDef), grants: z.record(z.string(), z.string()) }),
  },
  'role.grant': {
    params: z.object({ principal: z.string(), role: z.string(), agent: z.string().optional() }),
    result: ok,
  },
  /**
   * Create or replace a custom role, or override fields of a built-in one. `role` is any subset of
   * RoleDef fields plus `name` (validated server-side; unset fields keep the built-in / viewer base).
   * The owner and agent roles cannot be changed.
   */
  'role.define': {
    params: z.object({ role: z.record(z.string(), z.unknown()) }),
    result: RoleDef,
  },
  /** Delete a custom role (built-ins cannot be deleted; an override of one is reset). Fails while granted. */
  'role.delete': { params: byName, result: ok },
  'role.revoke': { params: z.object({ principal: z.string(), agent: z.string().optional() }), result: ok },
  'principal.link': { params: z.object({ person: z.string(), principal: z.string() }), result: ok },
  /** Unlink a principal from a person. */
  'principal.unlink': { params: z.object({ person: z.string(), principal: z.string() }), result: ok },
  /** Linked identities: person → principals. */
  'principal.list': {
    params: empty,
    result: z.object({ people: z.record(z.string(), z.array(z.string())) }),
  },
  /** Configured owners with their linked people and identities (the local owner is implicit). */
  'owner.list': {
    params: empty,
    result: z.object({
      owners: z.array(
        z.object({ principal: z.string(), person: z.string().optional(), linked: z.array(z.string()) }),
      ),
    }),
  },
  'owner.add': { params: z.object({ principal: z.string() }), result: ok },
  'owner.remove': { params: z.object({ principal: z.string() }), result: ok },

  'policy.get': {
    params: byName,
    result: z.object({
      profile: z.string(),
      effective: SandboxPolicy,
      /** Hosts the harness and its sign-in need, added to the sandbox at session start. */
      required: z.array(z.object({ host: z.string(), source: z.string() })).default([]),
      /** The agent's own allowlist additions (the profile's defaults are not listed). */
      userAllow: z.array(z.string()).default([]),
    }),
  },
  /** Probe the hosts a harness needs through the agent's sandbox policy and report which are reachable. */
  'sandbox.test': {
    params: byName,
    result: z.object({
      results: z.array(
        z.object({
          host: z.string(),
          source: z.string(),
          status: z.enum(['ok', 'blocked', 'unreachable', 'skipped']),
          detail: z.string().optional(),
        }),
      ),
    }),
  },
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

  /** Effective alert thresholds (config `alerts` over the defaults). */
  'alerts.get': { params: empty, result: AlertRules },
  /** Merge alert thresholds into config; returns the effective rules. */
  'alerts.set': { params: AlertRulesPatch, result: AlertRules },

  /** Update toggles (config `updates`). */
  'updates.get': {
    params: empty,
    result: z.object({ catalogAuto: z.boolean(), appPrompt: z.boolean() }),
  },
  'updates.set': {
    params: z.object({ catalogAuto: z.boolean().optional(), appPrompt: z.boolean().optional() }),
    result: z.object({ catalogAuto: z.boolean(), appPrompt: z.boolean() }),
  },

  /**
   * Directory listing for the path picker (owner only): directories under the home directory (or
   * another allowed root), git repos marked, hidden and always-denied paths left out. No file contents.
   */
  'fs.list': {
    params: z.object({ path: z.string().optional() }).default({}),
    result: z.object({
      path: z.string(),
      parent: z.string().optional(),
      roots: z.array(z.string()),
      entries: z.array(FsEntry),
    }),
  },

  'secret.list': {
    params: empty,
    result: z.object({
      secrets: z.array(z.object({ name: z.string(), updatedAt: z.string().optional() })),
      backend: z.string(),
      /** Where the vault key is kept: `file` (default), `keychain` (opt-in) or `passphrase` (env). */
      keySource: z.enum(['file', 'keychain', 'passphrase']).optional(),
      /** Whether the OS keychain can be used on this computer. */
      keychainAvailable: z.boolean().optional(),
    }),
  },
  /** Move the vault key between its 0600 key file and the OS keychain. The vault is not re-encrypted. */
  'secret.setKeySource': {
    params: z.object({ keySource: z.enum(['file', 'keychain']) }),
    result: z.object({ keySource: z.enum(['file', 'keychain', 'passphrase']) }),
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
      /** Per-mount sync choices (paths must be the agent's mounts). */
      mounts: z.array(DeployMountChoice).optional(),
      harnessAuth: HarnessAuth.optional(),
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
      mounts: z.array(DeployMountChoice).optional(),
      harnessAuth: HarnessAuth.optional(),
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
  /**
   * `uri` is the hosted PWA pairing URL (`https://app.beamhop.dev/pair#<payload>`), `link` the
   * `beamhop://pair#<payload>` deep link; render `uri` as the QR code. With `requireConfirm` the
   * device only joins the allowlist after `device.pairConfirm` (safety phrase checked on this side).
   */
  'device.pairStart': {
    params: z
      .object({ name: z.string().default('New device'), requireConfirm: z.boolean().default(false) })
      .default({ name: 'New device', requireConfirm: false }),
    result: z.object({
      uri: z.string(),
      code: z.string(),
      expiresAt: z.string(),
      pairingId: z.string().optional(),
      payload: z.string().optional(),
      link: z.string().optional(),
      daemonNpub: z.string().optional(),
      relays: z.array(z.string()).optional(),
    }),
  },
  'device.pairComplete': {
    params: z.object({ code: z.string(), pubkey: z.string(), name: z.string() }),
    result: DeviceView,
  },
  /** Poll a pairing started with device.pairStart (the safety phrase appears once a device answered). */
  'device.pairStatus': {
    params: z.object({ pairingId: z.string() }),
    result: PairingStatusView,
  },
  /** Trusted-side confirmation of the safety phrase; `accept: false` cancels and logs a failed pairing. */
  'device.pairConfirm': {
    params: z.object({ pairingId: z.string(), accept: z.boolean() }),
    result: PairingStatusView,
  },
  'device.remove': { params: z.object({ id: z.string() }), result: ok },
  /**
   * Store (or with `subscription: null` remove) a Web Push subscription (`PushSubscription.toJSON()`).
   * `id` is the paired device id, or `"browser"` for the PWA served by the local daemon.
   */
  'device.pushSubscribe': { params: z.object({ id: z.string(), subscription: z.unknown() }), result: ok },
  /** The daemon's VAPID public key (base64url), the `applicationServerKey` for `pushManager.subscribe`. */
  'device.pushKey': { params: empty, result: z.object({ publicKey: z.string() }) },
  /** Read (no `prefs`) or merge per-device notification categories. Unset categories default to on. */
  'device.pushPrefs': {
    params: z.object({ id: z.string(), prefs: z.partialRecord(PushCategory, z.boolean()).optional() }),
    result: z.object({ id: z.string(), prefs: PushPrefs }),
  },

  'identity.get': {
    params: empty,
    result: z.object({
      npub: z.string().optional(),
      /** True when the daemon holds the owner's secret key (created by `identity.ownerCreate`). */
      ownerKeyHeld: z.boolean().optional(),
      /** Daemon control-plane npub (what paired devices talk to). */
      daemonNpub: z.string().optional(),
      agents: z.array(
        z.object({
          name: z.string(),
          npub: z.string().optional(),
          nip05: z.string().optional(),
          attested: z.boolean().optional(),
        }),
      ),
    }),
  },
  /** Create a new owner key in the secret store; sets `owners` and `nostr.ownerNpub`. */
  'identity.ownerCreate': {
    params: z.object({ replace: z.boolean().default(false) }).default({ replace: false }),
    result: z.object({ npub: z.string() }),
  },
  /** Use an existing owner key (signing stays on the owner's device; the daemon keeps only the npub). */
  'identity.ownerImport': { params: z.object({ npub: z.string() }), result: z.object({ npub: z.string() }) },
  /** Reveal the daemon-held owner nsec, once, to a local client. Never available over Nostr. */
  'identity.ownerExport': { params: empty, result: z.object({ nsec: z.string() }) },
  /** Unsigned owner attestation for an agent, for an owner whose key lives on another device. */
  'identity.attestationTemplate': {
    params: byName,
    result: z.object({ template: EventTemplateView, ownerNpub: z.string(), agentNpub: z.string() }),
  },
  /** Publish an owner-signed attestation (verified against the agent and owner first). */
  'identity.attest': {
    params: z.object({ name: z.string(), event: z.record(z.string(), z.unknown()) }),
    result: ok,
  },
  /** (Re)publish an agent's kind 0 profile, attestation (if possible) and NIP-89 card. */
  'identity.publish': {
    params: byName,
    result: z.object({
      npub: z.string(),
      published: z.array(z.object({ kind: z.number(), id: z.string(), relays: z.array(z.string()) })),
      attestation: z.enum(['published', 'needs-owner-signature', 'no-owner']),
    }),
  },
  /** Onboarding step 06: the agent DMs the owner "hello" over Nostr. */
  'onboarding.hello': {
    params: z.object({ agent: z.string(), text: z.string().optional() }),
    result: z.object({ to: z.string(), from: z.string(), id: z.string(), sentAt: z.string() }),
  },
  /** Has the owner (or a paired device) replied to the hello DM? */
  'onboarding.helloStatus': {
    params: z.object({ agent: z.string() }),
    result: z.object({
      sent: z.boolean(),
      replied: z.boolean(),
      sentAt: z.string().optional(),
      repliedAt: z.string().optional(),
      from: z.string().optional(),
      text: z.string().optional(),
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
    /** Transcripts and usage; the audit log too only with `includeAudit`. */
    params: z
      .object({
        agent: z.string().optional(),
        before: z.string().optional(),
        includeAudit: z.boolean().default(false),
      })
      .default({ includeAudit: false }),
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
  | { type: 'panic'; active: boolean }
  /** Periodic, encrypted liveness beat from a cloud daemon to its owners and controllers (§9B). */
  | {
      type: 'daemon.heartbeat';
      heartbeat: {
        npub: string;
        agent?: string;
        at: string;
        panic: boolean;
        activeSessions: number;
        version: string;
      };
    };

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
