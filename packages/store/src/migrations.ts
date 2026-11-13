export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Append-only. Never edit a released migration; add a new one. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  channel TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  title_enc TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  ended_at TEXT,
  worktree_path TEXT,
  worktree_branch TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  harness TEXT,
  resume_enc TEXT,
  principal TEXT,
  next_seq INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX sessions_agent ON sessions(agent, last_activity_at);
CREATE INDEX sessions_thread ON sessions(agent, channel, conversation_id, thread_id);

CREATE TABLE session_events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_json TEXT,
  text_enc TEXT,
  tool_enc TEXT,
  approval_id TEXT,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE INDEX session_events_at ON session_events(at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  tool TEXT NOT NULL,
  title_enc TEXT NOT NULL,
  input_enc TEXT,
  risk TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  kind TEXT NOT NULL DEFAULT 'tool',
  votes TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX approvals_status ON approvals(status, created_at);
CREATE INDEX approvals_agent ON approvals(agent, created_at);

CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  agent TEXT,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_at ON audit(at);
CREATE INDEX audit_agent ON audit(agent, at);

CREATE TABLE usage (
  day TEXT NOT NULL,
  agent TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  peer TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  minutes REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, agent, channel, peer)
) WITHOUT ROWID;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pubkey TEXT NOT NULL UNIQUE,
  paired_at TEXT NOT NULL,
  last_seen_at TEXT,
  push_enabled INTEGER NOT NULL DEFAULT 0,
  push_sub_enc TEXT
);

CREATE TABLE kv (
  ns TEXT NOT NULL,
  key TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ns, key)
) WITHOUT ROWID;

CREATE TABLE policy_suggestions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  UNIQUE (agent, kind, value)
);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  region TEXT,
  size TEXT,
  created_at TEXT NOT NULL,
  monthly_cost_usd REAL,
  address TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE mesh_threads (
  key TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  hops INTEGER NOT NULL DEFAULT 0,
  human_required INTEGER NOT NULL DEFAULT 0,
  last_human_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE dedupe (
  channel TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (channel, message_id)
) WITHOUT ROWID;
CREATE INDEX dedupe_seen ON dedupe(seen_at);
`,
  },
];
