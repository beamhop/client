/**
 * Demo data for the in-browser mock daemon. A believable small team setup:
 * alice (owner) runs reviewer (Claude Code), ci-bot (Codex, on Fly), helpdesk (Gemini CLI, public,
 * learning mode) and scribe (OpenCode, stopped), reachable over Nostr, Telegram, Slack and Discord.
 * All times are relative to page load so the demo always looks "current".
 */
import {
  AgentConfig,
  type AgentConfigInput,
  type AgentView,
  type ApprovalView,
  type AuditEvent,
  ChannelConfig,
  type ChannelView,
  DEFAULT_ROLES,
  type DeploymentView,
  type DeviceView,
  type DoctorCheck,
  type HarnessView,
  type PolicySuggestion,
  type RoleDef,
  SandboxPolicy,
  ScheduleConfig,
  type SessionEventView,
  type SessionView,
  type UsageRow,
} from '@beamhop/core';

export const OWNER = {
  name: 'alice',
  npub: 'npub1alc3q8zk2m4v7hx9r0s6w5ud3fy8pt2n7l4k0g6c9e1j5a3s8d2q7wmz4k',
  principal: 'nostr:npub1alc3q8zk2m4v7hx9r0s6w5ud3fy8pt2n7l4k0g6c9e1j5a3s8d2q7wmz4k',
};
export const BOB = {
  name: 'bob',
  principal: 'nostr:npub1b0bz7f3k9q2w8e4r6t1y5u0i3o7p9a2s4d6f8g0h1j3k5l7z9x2c4vqh8',
};

export const NPUBS = {
  reviewer: 'npub1x7k4m2q9r8t5w3e6y1u0i7o4p2a5s8d3f6g9h1j4k7l0z2x5c8v3b6n9q9fz',
  'ci-bot': 'npub1c1b07q4w7e2r5t8y3u6i9o1p4a7s0d3f5g8h2j6k9l1z4x7c0v3b5n8m2kd7',
  helpdesk: 'npub1h3lpd9s2k5j8h1g4f7d0s3a6p9o2i5u8y1t4r7e0w3q6z9x2c5v8b1n4m8w3e',
  scribe: 'npub1scr1b3e5r8t1y4u7i0o3p6a9s2d5f8g1h4j7k0l3z6x9c2v5b8n1m4q7w0p6r',
  stranger: 'npub1qz8k4w7e2r9t5y1u6i3o0p8a4s7d2f9g5h1j6k3l0z8x4c7v2b9n5m1q8k4',
};

export const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
];

const MIN = 60_000;
export const ago = (now: number, minutes: number) => new Date(now - minutes * MIN).toISOString();
export const ahead = (now: number, minutes: number) => new Date(now + minutes * MIN).toISOString();

/** Deterministic PRNG so the demo (and screenshots) look the same on every load. */
export const prng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const agent = (
  cfg: AgentConfigInput,
  view: Omit<AgentView, 'config' | 'usageToday' | 'location'> & {
    usageToday?: AgentView['usageToday'];
    location?: AgentView['location'];
  },
): AgentView => ({
  config: AgentConfig.parse(cfg),
  usageToday: view.usageToday ?? { usd: 0, tokens: 0, minutes: 0 },
  location: view.location ?? { kind: 'local' },
  ...view,
});

export interface MockState {
  now: number;
  startedAt: number;
  panic: { active: boolean; at?: string; snapshot?: { agents: string[]; schedules: string[] } };
  agents: Map<string, AgentView>;
  harnesses: HarnessView[];
  channels: Map<string, ChannelView>;
  sessions: Map<string, SessionView>;
  events: Map<string, SessionEventView[]>;
  approvals: Map<string, ApprovalView>;
  audit: AuditEvent[];
  usage: UsageRow[];
  devices: DeviceView[];
  schedules: ScheduleConfig[];
  deployments: DeploymentView[];
  suggestions: PolicySuggestion[];
  secrets: { name: string; updatedAt?: string }[];
  roles: RoleDef[];
  grants: Record<string, string>;
  owners: string[];
  policies: Map<string, { profile: string; effective: SandboxPolicy }>;
  doctor: DoctorCheck[];
}

export const seed = (now = Date.now()): MockState => {
  const rnd = prng(842);

  // ─────────── Agents ───────────
  const agents = new Map<string, AgentView>();
  agents.set(
    'reviewer',
    agent(
      {
        name: 'reviewer',
        displayName: 'reviewer',
        description: 'Reviews and fixes code in acme/app. Pushes to beamhop/* branches only.',
        harness: 'claude',
        model: 'default',
        mounts: [
          { path: '~/code/app', mode: 'rw' },
          { path: '~/notes', mode: 'ro' },
        ],
        sandbox: { profile: 'workspace' },
        identity: { npub: NPUBS.reviewer, nip05: 'reviewer@example.com', nostrKeyRef: 'agent/reviewer' },
        memberships: [
          { target: 'tg:group/-100123', defaultRole: 'user', triggers: ['mention', 'reply'] },
          { target: 'nostr:dm', defaultRole: 'viewer', triggers: ['dm'] },
        ],
        routes: [{ from: 'nostr:dm', to: 'acme:channel/C0DEPLOYS' }],
        grants: { 'telegram:5551': 'user', [BOB.principal]: 'admin' },
        budgets: { dailyUsd: 5, perSessionMinutes: 45 },
        concurrency: { maxSessions: 3 },
        preset: 'team-dev-bot',
      },
      {
        status: 'busy',
        activeSessions: 1,
        lastActivityAt: ago(now, 0.4),
        usageToday: { usd: 3.2, tokens: 412_800, minutes: 38 },
      },
    ),
  );
  agents.set(
    'ci-bot',
    agent(
      {
        name: 'ci-bot',
        description: 'Ships staging when asked in #deploys. Reads CI logs.',
        harness: 'codex',
        model: 'gpt-5-codex',
        mounts: [{ path: '~/code/app', mode: 'ro' }],
        sandbox: { profile: 'strict' },
        identity: { npub: NPUBS['ci-bot'] },
        memberships: [{ target: 'acme:channel/C0DEPLOYS', defaultRole: 'user', triggers: ['mention'] }],
        budgets: { dailyUsd: 8 },
        concurrency: { maxSessions: 2 },
        harnessAuth: 'api-key',
      },
      {
        status: 'idle',
        activeSessions: 0,
        lastActivityAt: ago(now, 128),
        usageToday: { usd: 1.1, tokens: 148_200, minutes: 12 },
        location: { kind: 'cloud', provider: 'fly' },
      },
    ),
  );
  agents.set(
    'helpdesk',
    agent(
      {
        name: 'helpdesk',
        description: 'Answers product questions from anyone. Read-only docs, strict rate limits.',
        harness: 'gemini',
        mounts: [{ path: '~/docs/public', mode: 'ro' }],
        sandbox: { profile: 'custom' },
        identity: { npub: NPUBS.helpdesk, nip05: 'help@example.com' },
        public: true,
        memberships: [
          { target: 'nostr:public', defaultRole: 'viewer', triggers: ['dm', 'mention'] },
          { target: 'tg:group/-100777', defaultRole: 'viewer', triggers: ['mention'] },
        ],
        budgets: { dailyUsd: 2, messagesPerMinute: 6 },
        concurrency: { maxSessions: 2 },
        preset: 'public-qa',
      },
      {
        status: 'idle',
        activeSessions: 0,
        lastActivityAt: ago(now, 14),
        usageToday: { usd: 0.62, tokens: 96_400, minutes: 9 },
      },
    ),
  );
  agents.set(
    'scribe',
    agent(
      {
        name: 'scribe',
        description: 'Turns meeting notes into todo lists in ~/notes.',
        harness: 'opencode',
        mounts: [{ path: '~/notes', mode: 'rw', parallelUnsafe: false }],
        sandbox: { profile: 'workspace' },
        identity: { npub: NPUBS.scribe },
        memberships: [{ target: 'nostr:dm', defaultRole: 'viewer', triggers: ['dm'] }],
        budgets: { dailyUsd: 3 },
        preset: 'personal-assistant',
      },
      { status: 'stopped', activeSessions: 0, lastActivityAt: ago(now, 60 * 74) },
    ),
  );

  // ─────────── Harnesses ───────────
  const harnesses: HarnessView[] = [
    {
      id: 'claude',
      displayName: 'Claude Code',
      command: 'claude',
      version: '2.1.4',
      path: '/usr/local/bin/claude',
      status: 'ready',
      protocol: 'acp',
      message: 'ACP ✓ · API key via broker',
    },
    {
      id: 'codex',
      displayName: 'Codex',
      command: 'codex',
      version: '0.9.1',
      path: '/usr/local/bin/codex',
      status: 'needs-login',
      protocol: 'acp',
      message: 'Run: codex login',
    },
    {
      id: 'gemini',
      displayName: 'Gemini CLI',
      command: 'gemini',
      version: '1.3.0',
      path: '/home/alice/.npm-global/bin/gemini',
      status: 'ready',
      protocol: 'acp',
      message: 'ACP ✓ · API key via broker',
    },
    {
      id: 'opencode',
      displayName: 'OpenCode',
      command: 'opencode',
      version: '0.18.2',
      path: '/home/alice/.local/bin/opencode',
      status: 'ready',
      protocol: 'acp',
    },
    {
      id: 'copilot',
      displayName: 'Copilot CLI',
      command: 'copilot',
      status: 'not-installed',
      protocol: 'acp',
      install: { npm: 'npm i -g @github/copilot', brew: 'brew install copilot-cli' },
    },
    {
      id: 'pi',
      displayName: 'pi',
      command: 'pi',
      version: '0.4.0',
      path: '/home/alice/.local/bin/pi',
      status: 'unsupported-version',
      protocol: 'rpc',
      message: 'Needs ≥0.5',
      install: { npm: 'npm i -g @mariozechner/pi-coding-agent@latest' },
    },
  ];

  // ─────────── Channels ───────────
  const channels = new Map<string, ChannelView>();
  channels.set('nostr', {
    config: ChannelConfig.parse({
      name: 'nostr',
      provider: 'nostr',
      settings: {
        relays: RELAYS,
        relaysUp: RELAYS.slice(0, 3),
        dms: 'NIP-17',
        groups: 2,
        // Per-relay round-trip and NIP-11 check (channel detail relay list).
        latencyMs: { 'wss://relay.damus.io': 84, 'wss://nos.lol': 131, 'wss://relay.primal.net': 62 },
        nip11: {
          'wss://relay.damus.io': 'ok',
          'wss://nos.lol': 'ok',
          'wss://relay.primal.net': 'ok',
          'wss://relay.nostr.band': 'timeout',
        },
        blossom: ['https://blossom.primal.net'],
      },
      createdAt: ago(now, 60 * 24 * 12),
    }),
    status: 'connected',
    self: { principal: `nostr:${NPUBS.reviewer}`, displayName: 'beamhop daemon' },
  });
  channels.set('tg', {
    config: ChannelConfig.parse({
      name: 'tg',
      provider: 'telegram',
      settings: {
        mode: 'long-poll',
        dms: 1,
        groups: 2,
        chats: [
          { target: 'group/-100123', title: 'app-dev' },
          { target: 'group/-100456', title: 'alice & bob' },
        ],
        pairings: [
          {
            principal: 'telegram:5551',
            displayName: 'Alice',
            handle: '@alice',
            role: 'owner',
            pairedAt: ago(now, 60 * 24 * 9),
          },
        ],
      },
      secretRefs: ['channel/tg/bot-token'],
      createdAt: ago(now, 60 * 24 * 9),
    }),
    status: 'connected',
    self: { principal: 'telegram:7712345', displayName: 'reviewer (beamhop)', handle: '@reviewer_alice_bot' },
  });
  channels.set('acme', {
    config: ChannelConfig.parse({
      name: 'acme',
      provider: 'slack',
      settings: { workspace: 'acme', team: 'T01ACME', mode: 'socket', channels: ['#deploys', '#eng'] },
      secretRefs: ['channel/acme/app-token', 'channel/acme/bot-token'],
      createdAt: ago(now, 60 * 24 * 6),
    }),
    status: 'connected',
    self: { principal: 'slack:T01ACME/U07BEAM', displayName: 'beamhop', handle: '@beamhop' },
  });
  channels.set('ops', {
    config: ChannelConfig.parse({
      name: 'ops',
      provider: 'discord',
      settings: { guild: 'acme-ops', applicationId: '1301928374655' },
      secretRefs: ['channel/ops/bot-token'],
      createdAt: ago(now, 60 * 24 * 3),
    }),
    status: 'error',
    error: 'Token rejected (401)',
    self: { principal: 'discord:1301928374655', displayName: 'beamhop-ops' },
  });

  // ─────────── Sessions ───────────
  const sessions = new Map<string, SessionView>();
  const ses = (s: SessionView) => sessions.set(s.id, s);
  ses({
    id: 'ses_842',
    agent: 'reviewer',
    channel: 'tg',
    conversationId: 'group/-100123',
    threadId: '842',
    title: 'can you fix the login redirect and push it?',
    status: 'running',
    startedAt: ago(now, 6.2),
    lastActivityAt: ago(now, 0.4),
    worktree: { path: '~/.beamhop/worktrees/app/beamhop-842', branch: 'beamhop/842' },
    usage: { inputTokens: 182_400, outputTokens: 9_420, usd: 0.38 },
  });
  ses({
    id: 'ses_839',
    agent: 'reviewer',
    channel: 'tg',
    conversationId: 'group/-100123',
    threadId: '839',
    title: 'review PR #211 (rate limiter)',
    status: 'ended',
    startedAt: ago(now, 190),
    lastActivityAt: ago(now, 141),
    worktree: { path: '~/.beamhop/worktrees/app/beamhop-839', branch: 'beamhop/839' },
    usage: { inputTokens: 402_100, outputTokens: 18_900, usd: 0.91 },
  });
  ses({
    id: 'ses_835',
    agent: 'reviewer',
    channel: 'nostr',
    conversationId: 'dm',
    threadId: 'dm-alice',
    title: "summarize yesterday's incidents",
    status: 'ended',
    startedAt: ago(now, 60 * 20),
    lastActivityAt: ago(now, 60 * 19.6),
    usage: { inputTokens: 64_000, outputTokens: 3_100, usd: 0.17 },
  });
  ses({
    id: 'ses_d17',
    agent: 'ci-bot',
    channel: 'acme',
    conversationId: 'channel/C0DEPLOYS',
    threadId: '1731.0042',
    title: 'deploy staging after #211 merges',
    status: 'idle',
    startedAt: ago(now, 150),
    lastActivityAt: ago(now, 128),
    usage: { inputTokens: 51_200, outputTokens: 2_400, usd: 0.22 },
  });
  ses({
    id: 'ses_d16',
    agent: 'ci-bot',
    channel: 'acme',
    conversationId: 'channel/C0DEPLOYS',
    threadId: '1730.9981',
    title: 'why did the nightly fail?',
    status: 'ended',
    startedAt: ago(now, 60 * 9),
    lastActivityAt: ago(now, 60 * 8.7),
    usage: { inputTokens: 88_000, outputTokens: 4_900, usd: 0.41 },
  });
  ses({
    id: 'ses_h31',
    agent: 'helpdesk',
    channel: 'nostr',
    conversationId: 'public',
    threadId: 'q-3391',
    title: 'How do I rotate my API key?',
    status: 'idle',
    startedAt: ago(now, 22),
    lastActivityAt: ago(now, 14),
    usage: { inputTokens: 12_800, outputTokens: 1_100, usd: 0.04 },
  });
  ses({
    id: 'ses_h30',
    agent: 'helpdesk',
    channel: 'tg',
    conversationId: 'group/-100777',
    threadId: '77',
    title: 'is the status page down?',
    status: 'ended',
    startedAt: ago(now, 60 * 5),
    lastActivityAt: ago(now, 60 * 4.9),
    usage: { inputTokens: 6_100, outputTokens: 420, usd: 0.02 },
  });
  ses({
    id: 'ses_s09',
    agent: 'scribe',
    channel: 'nostr',
    conversationId: 'dm',
    threadId: 'dm-alice-2',
    title: 'turn my meeting notes into a todo list',
    status: 'ended',
    startedAt: ago(now, 60 * 74.5),
    lastActivityAt: ago(now, 60 * 74),
    usage: { inputTokens: 21_000, outputTokens: 1_800, usd: 0.06 },
  });

  // ─────────── Session events ───────────
  const events = new Map<string, SessionEventView[]>();
  const alice = { principal: 'telegram:5551', displayName: 'Alice', role: 'user' };
  const diff = [
    'diff --git a/src/auth.ts b/src/auth.ts',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -38,9 +38,16 @@ export async function login(req: Request, res: Response) {',
    '   const user = await verify(req.body);',
    '   if (!user) return res.status(401).end();',
    '   const next = req.query.next;',
    "-  res.redirect('/');",
    '+  res.redirect(safeNext(next));',
    ' }',
    'diff --git a/src/util/url.ts b/src/util/url.ts',
    '--- a/src/util/url.ts',
    '+++ b/src/util/url.ts',
    '@@ -1,3 +1,8 @@',
    '+export const safeNext = (next: unknown): string => {',
    "+  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return '/';",
    '+  return next;',
    '+};',
  ].join('\n');
  let seq = 0;
  const e842 = (minAgo: number, ev: Omit<SessionEventView, 'seq' | 'at'>): SessionEventView => ({
    seq: ++seq,
    at: ago(now, minAgo),
    ...ev,
  });
  events.set('ses_842', [
    e842(6.2, {
      kind: 'user',
      from: alice,
      text: 'can you fix the login redirect and push it? users land on / instead of where they were.',
    }),
    e842(6.0, { kind: 'assistant', text: 'Looking at the auth flow first.' }),
    e842(5.9, {
      kind: 'tool_call',
      tool: { id: 't1', name: 'Read', title: 'Read src/auth.ts', input: { path: 'src/auth.ts' } },
    }),
    e842(5.9, { kind: 'tool_result', tool: { id: 't1', name: 'Read', ok: true, output: '84 lines' } }),
    e842(5.8, {
      kind: 'tool_call',
      tool: { id: 't2', name: 'Grep', title: 'Grep "redirect"', input: { pattern: 'redirect' } },
    }),
    e842(5.8, {
      kind: 'tool_result',
      tool: { id: 't2', name: 'Grep', ok: true, output: '4 hits in 2 files' },
    }),
    e842(5.6, {
      kind: 'assistant',
      text: 'The redirect drops the `next` param. Fixing it in two places, and guarding against open redirects (`//evil.example`).',
    }),
    e842(5.1, {
      kind: 'tool_call',
      tool: {
        id: 't3',
        name: 'Edit',
        title: 'Edit 2 files +14 −3',
        input: { files: ['src/auth.ts', 'src/util/url.ts'] },
      },
    }),
    e842(5.0, {
      kind: 'tool_result',
      tool: { id: 't3', name: 'Edit', ok: true, diff, output: '2 files changed' },
    }),
    e842(4.9, {
      kind: 'tool_call',
      tool: { id: 't4', name: 'Bash', title: 'Bash npm test', input: { command: 'npm test' } },
    }),
    e842(4.2, { kind: 'progress', text: 'running tests… 214 passing' }),
    e842(1.1, {
      kind: 'tool_result',
      tool: {
        id: 't4',
        name: 'Bash',
        ok: true,
        output: '✓ auth.test.ts (12)\n✓ url.test.ts (6)\n… 214 passing (41s)',
      },
    }),
    e842(0.6, { kind: 'assistant', text: 'Tests pass. Pushing the fix so CI can run.' }),
    e842(0.4, { kind: 'permission', approvalId: 'apr_a41f', text: 'git push origin beamhop/842' }),
    e842(0.2, { kind: 'usage', text: '$0.38 · 191k tokens' }),
  ]);
  events.set('ses_839', [
    { seq: 1, at: ago(now, 190), kind: 'user', from: alice, text: 'review PR #211 (rate limiter) please' },
    {
      seq: 2,
      at: ago(now, 188),
      kind: 'assistant',
      text: 'Reviewed #211. Two issues: the token bucket refills per request instead of per second, and the limiter key ignores the API key prefix. Suggested patches are in the thread.',
    },
  ]);
  events.set('ses_d17', [
    {
      seq: 1,
      at: ago(now, 150),
      kind: 'user',
      from: { principal: 'slack:T01ACME/U02BOB', displayName: 'Bob', role: 'user' },
      text: '@ci-bot deploy staging after #211 merges',
    },
    {
      seq: 2,
      at: ago(now, 149),
      kind: 'assistant',
      text: "Watching #211. I'll deploy staging when it merges and post the URL here.",
    },
  ]);
  events.set('ses_h31', [
    {
      seq: 1,
      at: ago(now, 22),
      kind: 'user',
      from: { principal: `nostr:${NPUBS.stranger}`, displayName: 'npub1qz…8k4', role: 'viewer' },
      text: 'How do I rotate my API key?',
    },
    {
      seq: 2,
      at: ago(now, 21),
      kind: 'assistant',
      text: 'Open Settings → API keys, choose the key, then Rotate. The old key keeps working for 24 hours so you can update your services.',
    },
  ]);

  // ─────────── Approvals ───────────
  const approvals = new Map<string, ApprovalView>();
  const apr = (a: Omit<ApprovalView, 'kind'> & { kind?: ApprovalView['kind'] }) =>
    approvals.set(a.id, { kind: 'tool', ...a });
  apr({
    id: 'apr_a41f',
    agent: 'reviewer',
    sessionId: 'ses_842',
    requestedBy: alice,
    tool: 'Bash',
    title: 'Run a shell command',
    input: {
      command: 'git push origin beamhop/842',
      why: 'pushing the fix so CI can run',
      channel: 'tg:group/-100123',
      thread: '842',
      rule: 'user → bash:git push = ask',
    },
    risk: 'high',
    createdAt: ago(now, 2.3),
    expiresAt: ahead(now, 12.67),
    status: 'pending',
  });
  apr({
    id: 'apr_b72c',
    agent: 'ci-bot',
    sessionId: 'ses_d17',
    requestedBy: { principal: 'slack:T01ACME/U02BOB', displayName: 'Bob', role: 'user' },
    tool: 'Fetch',
    title: 'Reach a new host',
    input: {
      host: 'registry.npmjs.org',
      url: 'https://registry.npmjs.org/@acme%2fui',
      firstTime: true,
      why: 'installing dependencies for the staging build',
      channel: 'acme:channel/C0DEPLOYS',
      rule: 'network → new host = ask',
    },
    risk: 'medium',
    createdAt: ago(now, 6.9),
    expiresAt: ahead(now, 8.03),
    status: 'pending',
  });
  apr({
    id: 'apr_c09e',
    agent: 'helpdesk',
    sessionId: 'ses_h31',
    requestedBy: { principal: `nostr:${NPUBS.stranger}`, displayName: 'npub1qz…8k4', role: 'viewer' },
    tool: 'Read',
    title: 'Read a file',
    input: {
      path: '~/docs/public/faq/api-keys.md',
      why: 'to quote the exact rotation steps',
      channel: 'nostr:public',
      rule: 'viewer → read outside mount = ask',
    },
    risk: 'low',
    createdAt: ago(now, 0.15),
    expiresAt: ahead(now, 14.85),
    status: 'pending',
  });
  apr({
    id: 'apr_d3e1',
    agent: 'helpdesk',
    sessionId: 'ses_h31',
    requestedBy: { principal: `nostr:${NPUBS.stranger}`, displayName: 'npub1qz…8k4', role: 'viewer' },
    tool: 'access',
    title: 'Unknown sender asked to talk',
    input: {
      principal: `nostr:${NPUBS.stranger}`,
      message: 'hi, can your helpdesk agent answer billing questions?',
    },
    risk: 'low',
    createdAt: ago(now, 31),
    expiresAt: ahead(now, 29),
    status: 'pending',
    kind: 'access-request',
  });
  // Decided recently (24 h)
  const decided: Array<[string, string, string, ApprovalView['status'], ApprovalView['risk'], number]> = [
    ['apr_9f20', 'reviewer', 'git push origin beamhop/839', 'approved', 'high', 150],
    ['apr_9e11', 'ci-bot', 'fly deploy --app acme-staging', 'approved', 'high', 210],
    ['apr_9c07', 'helpdesk', 'fetch status.acme.dev', 'denied', 'medium', 300],
    ['apr_9b55', 'reviewer', 'rm -rf node_modules/.cache', 'approved', 'low', 420],
    ['apr_9a31', 'scribe', 'write ~/notes/todo.md', 'expired', 'low', 60 * 26],
  ];
  for (const [id, ag, cmd, status, risk, m] of decided) {
    apr({
      id,
      agent: ag,
      sessionId: 'ses_old',
      requestedBy: { principal: OWNER.principal, displayName: 'alice', role: 'owner' },
      tool: 'Bash',
      title: 'Run a shell command',
      input: { command: cmd },
      risk,
      createdAt: ago(now, m + 2),
      expiresAt: ago(now, m - 13),
      status,
      decidedBy: status === 'expired' ? undefined : status === 'denied' ? 'bob' : 'alice',
      decidedAt: ago(now, m),
    });
  }

  // ─────────── Audit (14 days) ───────────
  const audit: AuditEvent[] = [];
  let aid = 1000;
  const au = (minAgo: number, e: Omit<AuditEvent, 'id' | 'at' | 'data'> & { data?: AuditEvent['data'] }) =>
    audit.push({ id: `aud_${aid++}`, at: ago(now, minAgo), data: {}, ...e });
  au(0.4, {
    agent: 'reviewer',
    actor: 'reviewer',
    type: 'approval.requested',
    severity: 'info',
    summary: 'reviewer asked to run git push origin beamhop/842',
    data: { approvalId: 'apr_a41f' },
  });
  au(3, {
    agent: 'helpdesk',
    actor: 'srt',
    type: 'sandbox.blocked_host',
    severity: 'security',
    summary: 'helpdesk was blocked from pypi.org (learning mode logged it)',
    data: { host: 'pypi.org', session: 'ses_h31' },
  });
  au(9, {
    agent: 'reviewer',
    actor: 'srt',
    type: 'sandbox.blocked_host',
    severity: 'security',
    summary: 'reviewer was blocked from 169.254.169.254 (cloud metadata)',
    data: { host: '169.254.169.254', session: 'ses_842' },
  });
  au(31, {
    agent: 'helpdesk',
    actor: `nostr:${NPUBS.stranger}`,
    type: 'sender.unknown',
    severity: 'warn',
    summary: 'npub1qz…8k4 asked to talk to helpdesk',
    data: {},
  });
  au(48, {
    actor: 'telegram:9911',
    type: 'pairing.failed',
    severity: 'security',
    summary: 'Failed pairing on tg: wrong code from @mallory_x',
    data: { channel: 'tg' },
  });
  au(128, {
    agent: 'ci-bot',
    actor: 'alice',
    type: 'approval.decided',
    severity: 'info',
    summary: 'alice allowed fly deploy --app acme-staging',
    data: {},
  });
  au(141, {
    agent: 'reviewer',
    actor: 'reviewer',
    type: 'session.ended',
    severity: 'info',
    summary: 'reviewer finished thread 839 · 3 files changed',
    data: { session: 'ses_839' },
  });
  au(150, {
    agent: 'reviewer',
    actor: 'alice',
    type: 'approval.decided',
    severity: 'info',
    summary: 'alice allowed git push origin beamhop/839',
    data: {},
  });
  au(300, {
    agent: 'helpdesk',
    actor: 'bob',
    type: 'approval.decided',
    severity: 'info',
    summary: 'bob denied fetch status.acme.dev',
    data: {},
  });
  au(380, {
    agent: 'reviewer',
    actor: 'dlp',
    type: 'dlp.redacted',
    severity: 'security',
    summary: "reviewer's reply to Alice contained something that looks like an AWS key. It was redacted.",
    data: { pattern: 'aws-key' },
  });
  au(60 * 8, {
    agent: 'reviewer',
    actor: 'mesh',
    type: 'mesh.hop_limit',
    severity: 'warn',
    summary: 'reviewer and summarizer hit the 6-turn limit in thread 822',
    data: {},
  });
  au(60 * 11, {
    actor: 'alice',
    type: 'config.changed',
    severity: 'info',
    summary: 'alice added registry.npmjs.org to reviewer’s network allowlist',
    data: { file: '~/.beamhop/agents/reviewer.yaml' },
  });
  au(60 * 22, {
    actor: 'alice',
    type: 'device.paired',
    severity: 'info',
    summary: 'alice paired iPhone · Safari',
    data: {},
  });
  au(60 * 26, {
    agent: 'scribe',
    actor: 'beamhopd',
    type: 'approval.expired',
    severity: 'warn',
    summary: 'Auto-denied write ~/notes/todo.md — the agent was told',
    data: {},
  });
  au(60 * 30, {
    agent: 'ci-bot',
    actor: 'alice',
    type: 'deploy.applied',
    severity: 'info',
    summary: 'ci-bot moved to fly · ams (shared-cpu-1x)',
    data: { deployment: 'dep_fly_ams1' },
  });
  au(60 * 40, {
    agent: 'helpdesk',
    actor: 'alice',
    type: 'policy.learning',
    severity: 'info',
    summary: 'alice turned on learning mode for helpdesk (7 days)',
    data: {},
  });
  au(60 * 52, {
    actor: 'alice',
    type: 'role.granted',
    severity: 'info',
    summary: 'alice made bob an admin on reviewer (signed)',
    data: { signed: true },
  });
  const blockedHosts = [
    'api.openai.com',
    'pypi.org',
    'files.pythonhosted.org',
    'registry.yarnpkg.com',
    'raw.githubusercontent.com',
    '169.254.169.254',
  ];
  for (let d = 2; d < 14; d++) {
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const host = blockedHosts[Math.floor(rnd() * blockedHosts.length)]!;
      const who = rnd() > 0.5 ? 'helpdesk' : 'reviewer';
      au(60 * 24 * d + Math.floor(rnd() * 600), {
        agent: who,
        actor: 'srt',
        type: 'sandbox.blocked_host',
        severity: 'security',
        summary: `${who} was blocked from ${host}`,
        data: { host },
      });
    }
    au(60 * 24 * d + 300, {
      agent: 'reviewer',
      actor: 'reviewer',
      type: 'session.ended',
      severity: 'info',
      summary: `reviewer finished thread ${800 - d * 3}`,
      data: {},
    });
    if (d % 4 === 0)
      au(60 * 24 * d + 120, {
        agent: 'reviewer',
        actor: 'srt',
        type: 'sandbox.blocked_path',
        severity: 'security',
        summary: 'reviewer tried to read ~/.ssh/id_ed25519 — blocked by design',
        data: { path: '~/.ssh/id_ed25519' },
      });
  }
  audit.sort((a, b) => b.at.localeCompare(a.at));

  // ─────────── Usage (14 days) ───────────
  const usage: UsageRow[] = [];
  const profile: Record<string, { lo: number; hi: number; channel: string; peer?: string }> = {
    reviewer: { lo: 0.8, hi: 4.4, channel: 'tg' },
    'ci-bot': { lo: 0.3, hi: 1.6, channel: 'acme' },
    helpdesk: { lo: 0.1, hi: 0.8, channel: 'nostr' },
    scribe: { lo: 0, hi: 0.45, channel: 'nostr', peer: 'summarizer' },
  };
  for (let d = 13; d >= 0; d--) {
    const day = new Date(now - d * 86_400_000).toISOString().slice(0, 10);
    const weekend = [0, 6].includes(new Date(now - d * 86_400_000).getDay());
    for (const [name, p] of Object.entries(profile)) {
      if (name === 'scribe' && d < 3) continue; // stopped 3 days ago
      let usd = p.lo + rnd() * (p.hi - p.lo);
      if (weekend) usd *= 0.35;
      if (d === 0) usd = agents.get(name)?.usageToday.usd ?? usd;
      usd = Math.round(usd * 100) / 100;
      const tok = Math.round(usd * 128_000);
      usage.push({
        day,
        agent: name,
        channel: p.channel,
        peer: p.peer,
        inputTokens: Math.round(tok * 0.94),
        outputTokens: Math.round(tok * 0.06),
        usd,
        minutes: Math.round(usd * 11),
      });
    }
  }

  // ─────────── Devices ───────────
  const devices: DeviceView[] = [
    {
      id: 'dev_iphone',
      name: 'iPhone · Safari',
      pubkey: 'npub1dvc1phn…7k2a',
      pairedAt: ago(now, 60 * 22),
      lastSeenAt: ago(now, 0),
      pushEnabled: true,
    },
    {
      id: 'dev_mac',
      name: 'MacBook · Firefox',
      pubkey: 'npub1dvc2mcb…q9w1',
      pairedAt: ago(now, 60 * 46),
      lastSeenAt: ago(now, 4),
      pushEnabled: false,
    },
    {
      id: 'dev_pixel',
      name: 'Pixel · Chrome',
      pubkey: 'npub1dvc3pxl…m3e8',
      pairedAt: ago(now, 60 * 24 * 120),
      lastSeenAt: ago(now, 60 * 24 * 94),
      pushEnabled: true,
    },
  ];

  // ─────────── Schedules ───────────
  const schedules: ScheduleConfig[] = [
    ScheduleConfig.parse({
      id: 'sch_standup',
      agent: 'reviewer',
      kind: 'cron',
      spec: '0 9 * * 1-5',
      timezone: 'Europe/Berlin',
      prompt: 'Post a summary of open PRs and failing checks.',
      postTo: 'acme:channel/C0ENG',
      owner: OWNER.principal,
    }),
    ScheduleConfig.parse({
      id: 'sch_nightly',
      agent: 'ci-bot',
      kind: 'webhook',
      spec: '/hooks/ci-nightly',
      prompt: 'Read the nightly CI log and explain any failure in one paragraph.',
      postTo: 'acme:channel/C0DEPLOYS',
      owner: OWNER.principal,
    }),
    ScheduleConfig.parse({
      id: 'sch_notes',
      agent: 'scribe',
      kind: 'file-change',
      spec: '~/notes/meetings/*.md',
      prompt: 'Extract action items into ~/notes/todo.md.',
      owner: OWNER.principal,
      paused: true,
    }),
  ];

  // ─────────── Deployments ───────────
  const deployments: DeploymentView[] = [
    {
      id: 'dep_fly_ams1',
      provider: 'fly',
      agent: 'ci-bot',
      status: 'running',
      region: 'ams',
      size: 'shared-cpu-1x · 1 GB',
      createdAt: ago(now, 60 * 30),
      monthlyCostUsd: 5.7,
    },
    {
      id: 'dep_hz_fsn1',
      provider: 'hetzner',
      agent: 'reviewer-staging',
      status: 'stopped',
      region: 'fsn1',
      size: 'cx22 · 2 vCPU 4 GB',
      createdAt: ago(now, 60 * 24 * 8),
      monthlyCostUsd: 4.9,
    },
  ];

  // ─────────── Policy ───────────
  const policies = new Map<string, { profile: string; effective: SandboxPolicy }>();
  policies.set('reviewer', {
    profile: 'workspace',
    effective: SandboxPolicy.parse({
      fs: {
        read: ['~/code/app', '~/notes'],
        write: ['~/code/app'],
        deny: ['~/.ssh', '~/.aws', '~/.config/gh'],
      },
      net: {
        allow: [
          'api.anthropic.com',
          'github.com',
          '*.githubusercontent.com',
          'registry.npmjs.org',
          'nodejs.org',
          'objects.githubusercontent.com',
        ],
      },
      secrets: [{ name: 'ANTHROPIC_API_KEY', host: 'api.anthropic.com', header: 'x-api-key' }],
    }),
  });
  policies.set('ci-bot', {
    profile: 'strict',
    effective: SandboxPolicy.parse({
      fs: { read: ['~/code/app'] },
      net: { allow: ['api.openai.com', 'github.com', 'api.fly.io'] },
      secrets: [
        { name: 'OPENAI_API_KEY', host: 'api.openai.com', prefix: 'Bearer' },
        { name: 'FLY_API_TOKEN', host: 'api.fly.io', prefix: 'Bearer' },
      ],
    }),
  });
  policies.set('helpdesk', {
    profile: 'custom',
    effective: SandboxPolicy.parse({
      fs: { read: ['~/docs/public'] },
      net: { allow: ['generativelanguage.googleapis.com', 'docs.acme.dev'] },
      secrets: [
        { name: 'GEMINI_API_KEY', host: 'generativelanguage.googleapis.com', header: 'x-goog-api-key' },
      ],
      learning: true,
    }),
  });
  policies.set('scribe', {
    profile: 'workspace',
    effective: SandboxPolicy.parse({
      fs: { read: ['~/notes'], write: ['~/notes'] },
      net: { allow: ['api.anthropic.com'] },
    }),
  });

  const suggestions: PolicySuggestion[] = [
    {
      id: 'sug_pypi',
      agent: 'helpdesk',
      kind: 'net.allow',
      value: 'pypi.org',
      count: 14,
      lastSeenAt: ago(now, 3),
    },
    {
      id: 'sug_npm',
      agent: 'helpdesk',
      kind: 'net.allow',
      value: 'registry.npmjs.org',
      count: 6,
      lastSeenAt: ago(now, 44),
    },
    {
      id: 'sug_pipcache',
      agent: 'helpdesk',
      kind: 'fs.read',
      value: '~/.cache/pip',
      count: 3,
      lastSeenAt: ago(now, 3),
    },
  ];

  const doctor: DoctorCheck[] = [
    { id: 'srt', title: 'srt runtime', status: 'ok', message: 'srt 0.6.2' },
    { id: 'bwrap', title: 'bubblewrap', status: 'ok', message: 'bubblewrap 0.9.0' },
    { id: 'socat', title: 'socat', status: 'ok', message: 'socat 1.8.0.0' },
    { id: 'rg', title: 'ripgrep', status: 'ok', message: 'ripgrep 14.1.1' },
    {
      id: 'userns',
      title: 'user namespaces (AppArmor)',
      status: 'warn',
      message: 'Restricted for unprivileged users. bwrap needs an exception.',
      fix: 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
    },
  ];

  return {
    now,
    startedAt: now - 3 * 3600_000 - 17 * 60_000,
    panic: { active: false },
    agents,
    harnesses,
    channels,
    sessions,
    events,
    approvals,
    audit,
    usage,
    devices,
    schedules,
    deployments,
    suggestions,
    secrets: [
      { name: 'ANTHROPIC_API_KEY', updatedAt: ago(now, 60 * 24 * 12) },
      { name: 'OPENAI_API_KEY', updatedAt: ago(now, 60 * 24 * 9) },
      { name: 'GEMINI_API_KEY', updatedAt: ago(now, 60 * 24 * 7) },
      { name: 'FLY_API_TOKEN', updatedAt: ago(now, 60 * 30) },
      { name: 'channel/tg/bot-token', updatedAt: ago(now, 60 * 24 * 9) },
      { name: 'channel/acme/app-token', updatedAt: ago(now, 60 * 24 * 6) },
      { name: 'channel/acme/bot-token', updatedAt: ago(now, 60 * 24 * 6) },
      { name: 'channel/ops/bot-token', updatedAt: ago(now, 60 * 24 * 3) },
    ],
    roles: DEFAULT_ROLES,
    grants: { [BOB.principal]: 'admin', 'telegram:5551': 'user', 'slack:T01ACME/U02BOB': 'user' },
    owners: [OWNER.principal],
    policies,
    doctor,
  };
};
