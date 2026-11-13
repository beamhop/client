/**
 * Pure transcript + list logic for the Sessions screens (no React). Unit-tested in model.test.ts.
 *
 * - `buildTranscript` turns the flat `session.events` stream into display blocks: tool_call/tool_result
 *   pairs become one tool row (progress lines attach to the tool that is running), ≥3 consecutive tool
 *   rows collapse into a "tool run", and a "files changed" summary closes each finished turn that
 *   edited files. Agent prose is never folded into a run (JOURNEYS §3).
 * - `currentActivity` drives the progress strip above the composer.
 * - `filterSessions` / `groupByAgent` / `neighbours` drive the list, filters and prev/next.
 */
import type { ApprovalView, SessionEventView, SessionView } from '@beamhop/core';
import { parseDiff } from '../../ui/CodeBlock.tsx';

export type ToolStatus = 'running' | 'ok' | 'failed' | 'denied';

export interface ToolItem {
  kind: 'tool';
  key: string;
  id: string;
  name: string;
  /** `Read`, `Bash`, `Edit` … */
  verb: string;
  /** Mono part of the title: `src/auth.ts`, `npm test`. */
  target: string;
  input?: unknown;
  output?: string;
  diff?: string;
  status: ToolStatus;
  startedAt: string;
  endedAt?: string;
  /** Progress lines emitted while this tool ran (live tail). */
  progress: string[];
  seq: number;
}

export interface ChangesSummary {
  kind: 'changes';
  key: string;
  diff: string;
  files: number;
  added: number;
  removed: number;
  at: string;
}

export type Block =
  | { kind: 'user'; key: string; ev: SessionEventView }
  | { kind: 'assistant'; key: string; ev: SessionEventView; streaming: boolean }
  | ToolItem
  | { kind: 'run'; key: string; tools: ToolItem[] }
  | { kind: 'permission'; key: string; ev: SessionEventView }
  | { kind: 'progress'; key: string; ev: SessionEventView }
  | { kind: 'system'; key: string; ev: SessionEventView }
  | { kind: 'error'; key: string; ev: SessionEventView }
  | ChangesSummary;

/** Consecutive tool rows at or above this count collapse into one run row. */
export const RUN_MIN = 3;

export const splitTitle = (name: string, title?: string): { verb: string; target: string } => {
  const t = (title ?? name).trim();
  if (t === name) return { verb: name, target: '' };
  if (t.startsWith(`${name} `)) return { verb: name, target: t.slice(name.length + 1) };
  return { verb: name, target: t };
};

export const diffStats = (diff: string) => {
  const files = parseDiff(diff);
  return {
    files: files.length,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
  };
};

const toolStatus = (ok: boolean | undefined, output?: string): ToolStatus =>
  ok === false ? (/\b(denied|blocked by policy)\b/i.test(output ?? '') ? 'denied' : 'failed') : 'ok';

/**
 * @param running whether the session is currently running (the last assistant event is streaming,
 *   the last turn is not finished yet).
 */
export const buildTranscript = (events: SessionEventView[], running: boolean): Block[] => {
  const flat: Block[] = [];
  const tools = new Map<string, ToolItem>();
  let turnDiffs: string[] = [];
  let lastRunning: ToolItem | undefined;

  const closeTurn = (at: string, key: string) => {
    if (turnDiffs.length === 0) return;
    const diff = turnDiffs.join('\n');
    flat.push({ kind: 'changes', key: `changes-${key}`, diff, at, ...diffStats(diff) });
    turnDiffs = [];
  };

  for (const ev of events) {
    const key = String(ev.seq);
    switch (ev.kind) {
      case 'user':
        closeTurn(ev.at, key);
        flat.push({ kind: 'user', key, ev });
        break;
      case 'assistant':
        flat.push({ kind: 'assistant', key, ev, streaming: false });
        break;
      case 'tool_call': {
        if (!ev.tool) break;
        const { verb, target } = splitTitle(ev.tool.name, ev.tool.title);
        const item: ToolItem = {
          kind: 'tool',
          key,
          id: ev.tool.id,
          name: ev.tool.name,
          verb,
          target,
          input: ev.tool.input,
          output: ev.tool.output,
          diff: ev.tool.diff,
          status: 'running',
          startedAt: ev.at,
          progress: [],
          seq: ev.seq,
        };
        tools.set(item.id, item);
        lastRunning = item;
        flat.push(item);
        break;
      }
      case 'tool_result': {
        const t = ev.tool && tools.get(ev.tool.id);
        if (!ev.tool) break;
        if (!t) {
          // Result without a call (joined mid-stream): show it as a finished row.
          const { verb, target } = splitTitle(ev.tool.name, ev.tool.title);
          const item: ToolItem = {
            kind: 'tool',
            key,
            id: ev.tool.id,
            name: ev.tool.name,
            verb,
            target,
            output: ev.tool.output,
            diff: ev.tool.diff,
            status: toolStatus(ev.tool.ok, ev.tool.output),
            startedAt: ev.at,
            endedAt: ev.at,
            progress: [],
            seq: ev.seq,
          };
          flat.push(item);
          if (item.diff) turnDiffs.push(item.diff);
          break;
        }
        t.status = toolStatus(ev.tool.ok, ev.tool.output);
        t.endedAt = ev.at;
        if (ev.tool.output !== undefined) t.output = ev.tool.output;
        if (ev.tool.diff) t.diff = ev.tool.diff;
        if (ev.tool.title) Object.assign(t, splitTitle(t.name, ev.tool.title));
        if (t.diff) turnDiffs.push(t.diff);
        if (lastRunning === t) lastRunning = undefined;
        break;
      }
      case 'progress':
        if (lastRunning && lastRunning.status === 'running' && ev.text) lastRunning.progress.push(ev.text);
        else flat.push({ kind: 'progress', key, ev });
        break;
      case 'permission':
        flat.push({ kind: 'permission', key, ev });
        break;
      case 'system':
        if (!running || ev !== events.at(-1)) closeTurn(ev.at, key);
        flat.push({ kind: 'system', key, ev });
        break;
      case 'error':
        flat.push({ kind: 'error', key, ev });
        break;
      case 'usage':
        break;
    }
  }
  const last = events.at(-1);
  if (!running && last) closeTurn(last.at, `end-${last.seq}`);

  // The newest assistant block streams while the session runs and nothing came after it.
  const tail = flat.at(-1);
  if (running && tail?.kind === 'assistant') tail.streaming = true;

  // Group ≥ RUN_MIN consecutive tool rows into runs.
  const out: Block[] = [];
  let buf: ToolItem[] = [];
  const flush = () => {
    if (buf.length >= RUN_MIN) out.push({ kind: 'run', key: `run-${buf[0]!.key}`, tools: buf });
    else out.push(...buf);
    buf = [];
  };
  for (const b of flat) {
    if (b.kind === 'tool') buf.push(b);
    else {
      flush();
      out.push(b);
    }
  }
  flush();
  return out;
};

/** All diffs of the session concatenated (diff sheet, inspector). */
export const sessionDiff = (events: SessionEventView[]): string =>
  events
    .filter((e) => e.kind === 'tool_result' && e.tool?.diff)
    .map((e) => e.tool!.diff!)
    .join('\n');

export const runSummary = (tools: ToolItem[]) => {
  const edits = tools.filter((t) => !!t.diff || /^(Edit|Write|MultiEdit|apply_patch)$/i.test(t.name)).length;
  const failed = tools.filter((t) => t.status === 'failed' || t.status === 'denied').length;
  const running = tools.find((t) => t.status === 'running');
  const start = new Date(tools[0]!.startedAt).getTime();
  const endIso = tools.reduce<string | undefined>(
    (m, t) => (t.endedAt && (!m || t.endedAt > m) ? t.endedAt : m),
    undefined,
  );
  const end = endIso ? new Date(endIso).getTime() : start;
  return { count: tools.length, edits, failed, running, ms: Math.max(0, end - start) };
};

/** `0.1s`, `42s`, `1m 04s`, `12m`. */
export const duration = (ms: number): string => {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m >= 10) return `${m}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
};

/** Live clock for the progress strip: `0:42`, `12:05`. */
export const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export type Activity =
  | { kind: 'tool'; label: string; detail?: string; since: string }
  | { kind: 'responding'; since: string }
  | { kind: 'waiting'; label: string; approvalId: string; since: string }
  | { kind: 'thinking'; since: string }
  | { kind: 'queued' };

/** What the agent is doing right now (progress strip, live region). `null` when idle/ended. */
export const currentActivity = (
  session: Pick<SessionView, 'status' | 'lastActivityAt'>,
  events: SessionEventView[],
  pending: Pick<ApprovalView, 'id' | 'status'>[] = [],
): Activity | null => {
  if (session.status === 'queued') return { kind: 'queued' };
  if (session.status !== 'running') return null;
  const pendingIds = new Set(pending.filter((a) => a.status === 'pending').map((a) => a.id));
  const open = new Map<string, SessionEventView>();
  let lastProgress: SessionEventView | undefined;
  let tail: SessionEventView | undefined;
  for (const e of events) {
    if (e.kind === 'usage') continue;
    tail = e;
    if (e.kind === 'tool_call' && e.tool) {
      open.set(e.tool.id, e);
      lastProgress = undefined;
    } else if (e.kind === 'tool_result' && e.tool) open.delete(e.tool.id);
    else if (e.kind === 'progress') lastProgress = e;
  }
  const waiting = [...events]
    .reverse()
    .find((e) => e.kind === 'permission' && e.approvalId && pendingIds.has(e.approvalId));
  if (waiting)
    return {
      kind: 'waiting',
      label: waiting.text ?? 'approval',
      approvalId: waiting.approvalId!,
      since: waiting.at,
    };
  const running = [...open.values()].at(-1);
  if (running?.tool) {
    const { verb, target } = splitTitle(running.tool.name, running.tool.title);
    return {
      kind: 'tool',
      label: target ? `${verb} ${target}` : verb,
      detail: lastProgress?.text,
      since: running.at,
    };
  }
  if (tail?.kind === 'assistant') return { kind: 'responding', since: tail.at };
  return { kind: 'thinking', since: tail?.at ?? session.lastActivityAt };
};

// ─────────── List ───────────

export type SessionFilter = 'live' | 'needs-you' | 'today' | 'all';

export const isActive = (s: SessionView) =>
  s.status === 'running' || s.status === 'queued' || s.status === 'idle';

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const filterSessions = (
  sessions: SessionView[],
  {
    filter,
    agent,
    needsYou,
    now = Date.now(),
  }: { filter: SessionFilter; agent?: string; needsYou: Set<string>; now?: number },
): SessionView[] =>
  sessions.filter((s) => {
    if (agent && s.agent !== agent) return false;
    switch (filter) {
      case 'live':
        return s.status === 'running' || s.status === 'queued';
      case 'needs-you':
        return needsYou.has(s.id);
      case 'today':
        return sameDay(new Date(s.lastActivityAt), new Date(now));
      default:
        return true;
    }
  });

export const filterCounts = (
  sessions: SessionView[],
  needsYou: Set<string>,
  agent?: string,
  now?: number,
) => {
  const c = (filter: SessionFilter) => filterSessions(sessions, { filter, agent, needsYou, now }).length;
  return { live: c('live'), 'needs-you': c('needs-you'), today: c('today'), all: c('all') };
};

/** Group by agent; groups ordered by their most recent activity, rows by last activity (newest first). */
export const groupByAgent = (sessions: SessionView[]): Array<{ agent: string; sessions: SessionView[] }> => {
  const m = new Map<string, SessionView[]>();
  for (const s of [...sessions].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))) {
    const list = m.get(s.agent) ?? [];
    list.push(s);
    m.set(s.agent, list);
  }
  return [...m.entries()].map(([agent, list]) => ({ agent, sessions: list }));
};

/**
 * Prev/next session of the same agent, in start order: `prev` is the older one, `next` the newer one.
 */
export const neighbours = (
  sessions: SessionView[],
  current: SessionView | undefined,
): { prev?: SessionView; next?: SessionView; index: number; total: number } => {
  if (!current) return { index: 0, total: 0 };
  const same = sessions
    .filter((s) => s.agent === current.agent)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const i = same.findIndex((s) => s.id === current.id);
  return { prev: same[i - 1], next: same[i + 1], index: i, total: same.length };
};

/** Sessions with a pending approval → "needs you". */
export const needsYouSet = (approvals: Pick<ApprovalView, 'sessionId' | 'status'>[] | undefined) =>
  new Set((approvals ?? []).filter((a) => a.status === 'pending').map((a) => a.sessionId));

/** Slash commands the composer understands (§6A.7). `local` ones are handled by the PWA. */
export const SLASH_COMMANDS = [
  { cmd: '/stop', local: true },
  { cmd: '/new', local: true },
  { cmd: '/details', local: true },
  { cmd: '/usage', local: true },
  { cmd: '/status', local: true },
  { cmd: '/model', local: false },
  { cmd: '/mode', local: false },
] as const;

export const matchSlash = (text: string) => {
  if (!text.startsWith('/') || /\s/.test(text.trim().slice(1)) || text.includes('\n')) return [];
  const q = text.trim().toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q));
};
