import type { AgentConfigInput, RoleDef } from './config.ts';

const ALL_COMMANDS = [
  'new',
  'stop',
  'status',
  'resume',
  'details',
  'approve',
  'deny',
  'model',
  'harness',
  'mode',
  'usage',
  'pair',
  'help',
];

/** Built-in role definitions (§6). Users can override by defining a role with the same name. */
export const DEFAULT_ROLES: RoleDef[] = [
  {
    name: 'owner',
    description: 'Full control. Approves risky actions. Still sandboxed.',
    canPrompt: true,
    permissionMode: 'ask',
    sandboxProfile: 'workspace',
    tools: { allow: [], deny: [] },
    requireApproval: [],
    commands: ALL_COMMANDS,
    canReconfigure: true,
    canApprove: true,
    dlp: 'warn',
    budget: {},
  },
  {
    name: 'admin',
    description: 'Can prompt, approve and reconfigure within limits.',
    canPrompt: true,
    permissionMode: 'ask',
    sandboxProfile: 'workspace',
    tools: { allow: [], deny: [] },
    requireApproval: ['bash*', 'shell*', 'write*', 'edit*', 'web_fetch*'],
    commands: ALL_COMMANDS,
    canReconfigure: true,
    canApprove: true,
    dlp: 'redact',
    budget: { messagesPerMinute: 20 },
  },
  {
    name: 'user',
    description: 'Can prompt the agent. Risky tools need owner approval.',
    canPrompt: true,
    permissionMode: 'ask',
    sandboxProfile: 'strict',
    tools: { allow: [], deny: [] },
    requireApproval: ['bash*', 'shell*', 'write*', 'edit*', 'web_fetch*', 'delete*'],
    commands: ['new', 'stop', 'status', 'resume', 'details', 'usage', 'help', 'pair'],
    canReconfigure: false,
    canApprove: false,
    dlp: 'redact',
    budget: { messagesPerMinute: 10, perSessionMinutes: 20 },
  },
  {
    name: 'viewer',
    description: 'Read-only Q&A. No file writes, no shell.',
    canPrompt: true,
    permissionMode: 'read-only',
    sandboxProfile: 'strict',
    tools: { allow: [], deny: ['bash*', 'shell*', 'write*', 'edit*', 'delete*'] },
    requireApproval: [],
    commands: ['new', 'status', 'help', 'usage', 'pair'],
    canReconfigure: false,
    canApprove: false,
    dlp: 'block',
    budget: { messagesPerMinute: 4, perSessionMinutes: 10 },
  },
  {
    name: 'agent',
    description: 'A peer agent in the mesh. Read-only, no approvals.',
    canPrompt: true,
    permissionMode: 'read-only',
    sandboxProfile: 'strict',
    tools: { allow: [], deny: ['bash*', 'shell*', 'write*', 'edit*', 'delete*'] },
    requireApproval: [],
    commands: ['status', 'help'],
    canReconfigure: false,
    canApprove: false,
    dlp: 'block',
    budget: { messagesPerMinute: 6 },
  },
];

export interface Preset {
  id: string;
  title: string;
  description: string;
  config: Partial<AgentConfigInput>;
}

/** Opinionated presets (decision table). */
export const PRESETS: Preset[] = [
  {
    id: 'personal-assistant',
    title: 'Personal assistant',
    description: 'Just you, over DMs. Can work in the folders you mount; asks before anything risky.',
    config: {
      sandbox: { profile: 'workspace' },
      memberships: [{ target: 'nostr:dm', defaultRole: 'viewer', triggers: ['dm'] }],
      budgets: { dailyUsd: 5 },
      public: false,
    },
  },
  {
    id: 'code-reviewer',
    title: 'Code reviewer',
    description: 'Reads your repo, never writes. Answers in team channels when mentioned.',
    config: {
      sandbox: { profile: 'strict' },
      budgets: { dailyUsd: 3 },
      concurrency: { maxSessions: 4 },
      public: false,
    },
  },
  {
    id: 'team-dev-bot',
    title: 'Team dev bot',
    description:
      'Teammates can ask for changes. Each thread gets its own git worktree; owners approve shell & writes.',
    config: {
      sandbox: { profile: 'workspace' },
      budgets: { dailyUsd: 15 },
      concurrency: { maxSessions: 3 },
      public: false,
    },
  },
  {
    id: 'public-qa',
    title: 'Public Q&A bot',
    description:
      'Anyone can ask. Strict sandbox, read-only docs, tight rate limits, secrets scanning on every reply.',
    config: {
      sandbox: { profile: 'strict' },
      budgets: { dailyUsd: 2 },
      concurrency: { maxSessions: 2 },
      public: true,
    },
  },
];
