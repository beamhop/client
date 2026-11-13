import type { z } from 'zod';
import type { SandboxPolicy } from './config.ts';
import type { ButtonPress, InboundMsg, OutboundMsgInput, SentMessage } from './messages.ts';

// ───────────────────────────── Setup wizards (§5) ─────────────────────────────

export type WizardField =
  | { kind: 'text'; id: string; label: string; placeholder?: string; help?: string; optional?: boolean }
  | { kind: 'secret'; id: string; label: string; help?: string; envFlag?: string }
  | { kind: 'select'; id: string; label: string; options: { value: string; label: string }[] }
  | { kind: 'list'; id: string; label: string; help?: string; default?: string[] };

export interface WizardStep {
  id: string;
  title: string;
  /** Markdown instructions. */
  body: string;
  /** Deep link / prefilled URL for the user to open (e.g. BotFather, Slack manifest). */
  link?: { label: string; url: string };
  fields: WizardField[];
}

export interface WizardValidation {
  ok: boolean;
  message: string;
  /** e.g. bot name + avatar to show after validation */
  identity?: { name: string; handle?: string; avatarUrl?: string };
}

export interface SetupWizard {
  steps: WizardStep[];
  /** Validate collected values (live API call). Secrets are passed in `secrets`. */
  validate(values: Record<string, unknown>, secrets: Record<string, string>): Promise<WizardValidation>;
}

// ───────────────────────────── Channels ─────────────────────────────

export interface ChannelContext {
  /** Channel instance name. */
  name: string;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
  log: Logger;
  /** Persistent per-channel KV (e.g. update offsets). */
  state: KV;
}

export interface ChannelConn {
  readonly name: string;
  readonly provider: string;
  /** Bot identity on this channel (used for mention detection). */
  readonly self: { principal: string; displayName: string; handle?: string };
  readonly capabilities: {
    edit: boolean;
    buttons: boolean;
    typing: boolean;
    files: boolean;
    threads: boolean;
  };
  inbound(): AsyncIterable<InboundMsg>;
  onButton?(handler: (press: ButtonPress) => void): void;
  /** Membership removal (kick) notifications (§7A). */
  onRemoved?(handler: (conversationId: string) => void): void;
  send(msg: OutboundMsgInput): Promise<SentMessage>;
  typing?(conversationId: string): Promise<void>;
  close(): Promise<void>;
}

export interface ChannelPlugin {
  id: string;
  displayName: string;
  setup: SetupWizard;
  connect(ctx: ChannelContext): Promise<ChannelConn>;
}

// ───────────────────────────── Harnesses (§3) ─────────────────────────────

export interface HarnessDetection {
  id: string;
  displayName: string;
  command: string;
  version?: string;
  path?: string;
  status: 'ready' | 'needs-login' | 'unsupported-version' | 'not-installed' | 'error';
  protocol: 'acp' | 'claude-sdk' | 'codex-app-server' | 'pi-rpc' | 'opencode';
  message?: string;
  capabilities?: { streaming: boolean; permissions: boolean; resume: boolean; mcp: boolean; images: boolean };
  install?: { npm?: string; brew?: string; winget?: string; url?: string };
}

export interface SessionSpec {
  sessionId: string;
  agent: string;
  model: string;
  /** Working directory inside the sandbox (first rw mount or a worktree). */
  cwd: string;
  mounts: { path: string; mode: 'ro' | 'rw' }[];
  permissionMode: 'read-only' | 'plan' | 'ask' | 'auto';
  /** Environment for the harness process (already scrubbed + broker placeholders). */
  env: Record<string, string>;
  /** MCP servers to inject (beamhop's channel/mesh server). */
  mcpServers: { name: string; command: string; args: string[]; env?: Record<string, string> }[];
  /** Harness-native resume token, if resuming. */
  resume?: string;
}

export type HarnessEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; title?: string }
  | { type: 'tool_result'; id: string; ok: boolean; output?: string; diff?: string }
  | {
      type: 'permission_request';
      id: string;
      tool: string;
      input: unknown;
      title: string;
      options?: string[];
    }
  | { type: 'progress'; message: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason: string; resume?: string };

export interface PermissionDecision {
  allow: boolean;
  /** Persist for the rest of the session. */
  always?: boolean;
  reason?: string;
}

export interface HarnessSession {
  readonly id: string;
  prompt(text: string, attachments?: { path: string; mime: string }[]): AsyncIterable<HarnessEvent>;
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface SandboxHandle {
  /** Wrap a command so it runs inside the sandbox. Returns the command line to spawn. */
  wrap(cmd: string, args: string[]): Promise<{ cmd: string; args: string[]; env: Record<string, string> }>;
  readonly policy: SandboxPolicy;
  readonly backend: string;
}

export interface HarnessPlugin {
  id: string;
  displayName: string;
  /** Hosts the harness itself needs (its own service), added to the sandbox's network allowlist. */
  network?: string[];
  /** Env var that relocates the harness's config/state dir; the daemon points it into the session dir. */
  homeEnv?: string;
  detect(): Promise<HarnessDetection | null>;
  start(spec: SessionSpec, sandbox: SandboxHandle): Promise<HarnessSession>;
}

// ───────────────────────────── Deployers (§10) ─────────────────────────────

export interface DeploySpec {
  agent: string;
  provider: string;
  region?: string;
  size?: string;
  mode: 'move' | 'new';
  harnesses: string[];
  image?: string;
  /** Per-mount sync choice (default: the deployer's plan per mount). Paths are the agent's mount paths. */
  mounts?: { path: string; sync: 'git-clone' | 'rsync' | 'mutagen' | 'skip' }[];
  /** Harness auth on the cloud host (default: the agent's `harnessAuth`). */
  harnessAuth?: 'api-key' | 'subscription';
}

export interface DeployPlan {
  provider: string;
  actions: { op: 'create' | 'update' | 'delete'; resource: string; detail: string }[];
  monthlyCostUsd: number;
  warnings: string[];
}

export interface Deployment {
  id: string;
  provider: string;
  agent: string;
  status: 'provisioning' | 'running' | 'stopped' | 'error' | 'destroyed';
  region?: string;
  size?: string;
  createdAt: string;
  address?: string;
}

export interface Deployer {
  id: string;
  displayName: string;
  kind: 'vps' | 'paas';
  sizes(): Promise<{ id: string; label: string; monthlyUsd: number }[]>;
  regions(): Promise<{ id: string; label: string }[]>;
  plan(spec: DeploySpec): Promise<DeployPlan>;
  apply(spec: DeploySpec): Promise<Deployment>;
  status(id: string): Promise<Deployment>;
  logs(id: string): AsyncIterable<string>;
  destroy(id: string): Promise<void>;
}

// ───────────────────────────── Shared infra ─────────────────────────────

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface KV {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Secret storage (§8). Values never leave the daemon except to the broker. */
export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<{ name: string; updatedAt?: string }[]>;
  /** `file`: the encrypted vault (always, outside tests). */
  readonly backend: 'file' | 'memory';
  /** Where the vault key is kept. */
  readonly keySource?: VaultKeySource;
}

/** Where the vault key lives: a 0600 key file (default), the OS keychain (opt-in), or a passphrase (env). */
export type VaultKeySource = 'file' | 'keychain' | 'passphrase';

export type ZodSchema<T> = z.ZodType<T>;
