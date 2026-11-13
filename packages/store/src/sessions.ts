import { BeamhopError, newId, type SessionEventView, type SessionView } from '@beamhop/core';
import type { DataCipher } from './crypto.ts';
import type { Db, Row } from './db.ts';

export type SessionStatus = SessionView['status'];

export interface CreateSessionInput {
  id?: string;
  agent: string;
  channel: string;
  conversationId: string;
  threadId: string;
  title?: string;
  status?: SessionStatus;
  principal?: string;
  harness?: string;
  worktree?: { path: string; branch: string };
  startedAt?: string;
}

export interface SessionPatch {
  title?: string;
  status?: SessionStatus;
  worktree?: { path: string; branch: string } | null;
  harness?: string;
  /** Harness-native resume token (stored encrypted). null clears it. */
  resume?: string | null;
  lastActivityAt?: string;
}

export interface SessionRecord extends SessionView {
  principal?: string;
  harness?: string;
  endedAt?: string;
}

export type NewSessionEvent = Omit<SessionEventView, 'seq' | 'at'> & { at?: string };

const ACTIVE: SessionStatus[] = ['running', 'idle', 'queued'];

export class SessionRepo {
  constructor(
    private readonly db: Db,
    private readonly cipher: DataCipher,
    private readonly now: () => Date,
  ) {}

  private toView(r: Row): SessionRecord {
    const view: SessionRecord = {
      id: r.id as string,
      agent: r.agent as string,
      channel: r.channel as string,
      conversationId: r.conversation_id as string,
      threadId: r.thread_id as string,
      title: this.cipher.decryptOpt('sessions.title', r.title_enc) ?? '',
      status: r.status as SessionStatus,
      startedAt: r.started_at as string,
      lastActivityAt: r.last_activity_at as string,
      usage: {
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        usd: Number(r.usd),
      },
    };
    if (r.worktree_path)
      view.worktree = { path: r.worktree_path as string, branch: r.worktree_branch as string };
    if (r.principal) view.principal = r.principal as string;
    if (r.harness) view.harness = r.harness as string;
    if (r.ended_at) view.endedAt = r.ended_at as string;
    return view;
  }

  create(input: CreateSessionInput): SessionRecord {
    const id = input.id ?? newId('ses');
    const at = input.startedAt ?? this.now().toISOString();
    this.db.run(
      `INSERT INTO sessions (id, agent, channel, conversation_id, thread_id, title_enc, status, started_at,
        last_activity_at, worktree_path, worktree_branch, principal, harness)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.agent,
      input.channel,
      input.conversationId,
      input.threadId,
      this.cipher.encryptOpt('sessions.title', input.title ?? ''),
      input.status ?? 'running',
      at,
      at,
      input.worktree?.path,
      input.worktree?.branch,
      input.principal,
      input.harness,
    );
    return this.get(id)!;
  }

  get(id: string): SessionRecord | undefined {
    const r = this.db.get('SELECT * FROM sessions WHERE id = ?', id);
    return r ? this.toView(r) : undefined;
  }

  require(id: string): SessionRecord {
    const s = this.get(id);
    if (!s) throw new BeamhopError('not_found', `session ${id} not found`);
    return s;
  }

  list(
    filter: { agent?: string; status?: SessionStatus | SessionStatus[]; limit?: number } = {},
  ): SessionRecord[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.agent) {
      where.push('agent = ?');
      params.push(filter.agent);
    }
    if (filter.status) {
      const st = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${st.map(() => '?').join(',')})`);
      params.push(...st);
    }
    const sql = `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY last_activity_at DESC, id DESC LIMIT ?`;
    return this.db.all(sql, ...params, filter.limit ?? 500).map((r) => this.toView(r));
  }

  /** The active (not ended) session for a thread, if any (§6A.5). */
  findActive(
    agent: string,
    channel: string,
    conversationId: string,
    threadId: string,
  ): SessionRecord | undefined {
    const r = this.db.get(
      `SELECT * FROM sessions WHERE agent = ? AND channel = ? AND conversation_id = ? AND thread_id = ?
        AND status IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY last_activity_at DESC LIMIT 1`,
      agent,
      channel,
      conversationId,
      threadId,
      ...ACTIVE,
    );
    return r ? this.toView(r) : undefined;
  }

  /** Most recent session for a thread, any status (for /resume). */
  findLatest(
    agent: string,
    channel: string,
    conversationId: string,
    threadId: string,
  ): SessionRecord | undefined {
    const r = this.db.get(
      `SELECT * FROM sessions WHERE agent = ? AND channel = ? AND conversation_id = ? AND thread_id = ?
        ORDER BY last_activity_at DESC, id DESC LIMIT 1`,
      agent,
      channel,
      conversationId,
      threadId,
    );
    return r ? this.toView(r) : undefined;
  }

  countActive(agent: string): number {
    return Number(
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sessions WHERE agent = ? AND status IN ('running', 'queued')`,
        agent,
      )?.n ?? 0,
    );
  }

  update(id: string, patch: SessionPatch): SessionRecord {
    const sets: string[] = [];
    const params: (string | null)[] = [];
    const set = (col: string, v: string | null) => {
      sets.push(`${col} = ?`);
      params.push(v);
    };
    if (patch.title !== undefined) set('title_enc', this.cipher.encrypt('sessions.title', patch.title));
    if (patch.status !== undefined) {
      set('status', patch.status);
      if (patch.status === 'ended' || patch.status === 'error') set('ended_at', this.now().toISOString());
    }
    if (patch.worktree !== undefined) {
      set('worktree_path', patch.worktree?.path ?? null);
      set('worktree_branch', patch.worktree?.branch ?? null);
    }
    if (patch.harness !== undefined) set('harness', patch.harness);
    if (patch.resume !== undefined)
      set('resume_enc', this.cipher.encryptOpt('sessions.resume', patch.resume));
    set('last_activity_at', patch.lastActivityAt ?? this.now().toISOString());
    const r = this.db.run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    if (r.changes === 0) throw new BeamhopError('not_found', `session ${id} not found`);
    return this.get(id)!;
  }

  /** Harness resume token (decrypted). */
  resumeToken(id: string): string | undefined {
    const r = this.db.get<{ resume_enc: string | null }>('SELECT resume_enc FROM sessions WHERE id = ?', id);
    return this.cipher.decryptOpt('sessions.resume', r?.resume_enc);
  }

  addUsage(id: string, u: { inputTokens?: number; outputTokens?: number; usd?: number }): void {
    this.db.run(
      `UPDATE sessions SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, usd = usd + ?,
        last_activity_at = ? WHERE id = ?`,
      Math.max(0, Math.round(u.inputTokens ?? 0)),
      Math.max(0, Math.round(u.outputTokens ?? 0)),
      Math.max(0, u.usd ?? 0),
      this.now().toISOString(),
      id,
    );
  }

  /** Mark idle sessions older than the cutoff as ended; returns their ids. */
  endIdle(agent: string, idleBefore: string): string[] {
    return this.db.tx(() => {
      const ids = this.db
        .all<{ id: string }>(
          `SELECT id FROM sessions WHERE agent = ? AND status IN ('idle', 'running') AND last_activity_at < ?`,
          agent,
          idleBefore,
        )
        .map((r) => r.id);
      for (const id of ids) this.update(id, { status: 'ended' });
      return ids;
    });
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM sessions WHERE id = ?', id).changes > 0;
  }

  // ───────────── events ─────────────

  /** Append an event; returns it with its per-session sequence number (1, 2, 3...). */
  appendEvent(sessionId: string, ev: NewSessionEvent): SessionEventView {
    return this.db.tx(() => {
      const row = this.db.get<{ seq: number }>(
        'UPDATE sessions SET next_seq = next_seq + 1, last_activity_at = ? WHERE id = ? RETURNING next_seq - 1 AS seq',
        ev.at ?? this.now().toISOString(),
        sessionId,
      );
      if (!row) throw new BeamhopError('not_found', `session ${sessionId} not found`);
      const seq = Number(row.seq);
      const at = ev.at ?? this.now().toISOString();
      this.db.run(
        `INSERT INTO session_events (session_id, seq, at, kind, from_json, text_enc, tool_enc, approval_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        sessionId,
        seq,
        at,
        ev.kind,
        ev.from ? JSON.stringify(ev.from) : null,
        this.cipher.encryptOpt('session_events.text', ev.text),
        this.cipher.encryptJson('session_events.tool', ev.tool),
        ev.approvalId,
      );
      const out: SessionEventView = { seq, at, kind: ev.kind };
      if (ev.from) out.from = ev.from;
      if (ev.text !== undefined) out.text = ev.text;
      if (ev.tool) out.tool = ev.tool;
      if (ev.approvalId) out.approvalId = ev.approvalId;
      return out;
    });
  }

  /**
   * Replace the text of an existing event (streaming assistant text keeps its seq while it grows).
   * Returns the updated event, or undefined when it does not exist.
   */
  updateEventText(sessionId: string, seq: number, text: string): SessionEventView | undefined {
    const n = this.db.run(
      'UPDATE session_events SET text_enc = ? WHERE session_id = ? AND seq = ?',
      this.cipher.encryptOpt('session_events.text', text),
      sessionId,
      seq,
    ).changes;
    if (!n) return undefined;
    const row = this.db.get<Row>(
      'SELECT * FROM session_events WHERE session_id = ? AND seq = ?',
      sessionId,
      seq,
    );
    return row ? this.eventView(row) : undefined;
  }

  events(sessionId: string, opts: { afterSeq?: number; limit?: number } = {}): SessionEventView[] {
    return this.db
      .all(
        'SELECT * FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        sessionId,
        opts.afterSeq ?? 0,
        opts.limit ?? 10_000,
      )
      .map((r) => this.eventView(r));
  }

  eventView(r: Row): SessionEventView {
    const out: SessionEventView = {
      seq: Number(r.seq),
      at: r.at as string,
      kind: r.kind as SessionEventView['kind'],
    };
    if (r.from_json) out.from = JSON.parse(r.from_json as string);
    const text = this.cipher.decryptOpt('session_events.text', r.text_enc);
    if (text !== undefined) out.text = text;
    const tool = this.cipher.decryptJson<SessionEventView['tool']>('session_events.tool', r.tool_enc);
    if (tool) out.tool = tool;
    if (r.approval_id) out.approvalId = r.approval_id as string;
    return out;
  }
}
