import type { SessionEventView, SessionView } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import {
  buildTranscript,
  currentActivity,
  duration,
  filterCounts,
  filterSessions,
  groupByAgent,
  matchSlash,
  neighbours,
  RUN_MIN,
  runSummary,
  sessionDiff,
  splitTitle,
  type ToolItem,
} from './model.ts';
import { parseInline, parseProse } from './prose.tsx';

let seq = 0;
const at = (s: number) => new Date(Date.UTC(2026, 10, 13, 10, 0, s)).toISOString();
const ev = (e: Omit<SessionEventView, 'seq' | 'at'> & { t?: number }): SessionEventView => {
  seq++;
  const { t, ...rest } = e;
  return { seq, at: at(t ?? seq), ...rest };
};
const call = (id: string, name: string, title?: string, t?: number) =>
  ev({ kind: 'tool_call', tool: { id, name, title }, t });
const result = (
  id: string,
  name: string,
  extra: Partial<NonNullable<SessionEventView['tool']>> = {},
  t?: number,
) => ev({ kind: 'tool_result', tool: { id, name, ok: true, ...extra }, t });

const DIFF = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,2 @@',
  '-x',
  '+y',
  '+z',
].join('\n');

describe('buildTranscript', () => {
  it('pairs tool calls with results and keeps prose between them visible', () => {
    seq = 0;
    const events = [
      ev({ kind: 'user', text: 'fix it', from: { principal: 'telegram:1', role: 'user' } }),
      ev({ kind: 'assistant', text: 'Looking.' }),
      call('t1', 'Read', 'Read src/a.ts'),
      result('t1', 'Read', { output: '84 lines' }),
      ev({ kind: 'assistant', text: 'Found it.' }),
      call('t2', 'Bash', 'Bash npm test'),
    ];
    const blocks = buildTranscript(events, true);
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
    const read = blocks[2] as ToolItem;
    expect(read).toMatchObject({ verb: 'Read', target: 'src/a.ts', status: 'ok', output: '84 lines' });
    expect((blocks[4] as ToolItem).status).toBe('running');
  });

  it('collapses consecutive tool calls into a run but never swallows prose', () => {
    seq = 0;
    const events = [
      ev({ kind: 'user', text: 'go' }),
      ...Array.from({ length: RUN_MIN }, (_, i) => [
        call(`r${i}`, 'Read', `Read f${i}`),
        result(`r${i}`, 'Read'),
      ]).flat(),
      ev({ kind: 'assistant', text: 'between' }),
      call('x', 'Read', 'Read last'),
      result('x', 'Read'),
    ];
    const blocks = buildTranscript(events, false);
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'run', 'assistant', 'tool']);
    const run = blocks[1];
    expect(run?.kind === 'run' && run.tools).toHaveLength(RUN_MIN);
  });

  it('attaches progress to the running tool and shows orphan progress as rows', () => {
    seq = 0;
    const events = [
      ev({ kind: 'progress', text: 'warming up' }),
      call('b', 'Bash', 'Bash npm test'),
      ev({ kind: 'progress', text: '12 passing' }),
      ev({ kind: 'progress', text: '214 passing' }),
    ];
    const blocks = buildTranscript(events, true);
    expect(blocks[0]?.kind).toBe('progress');
    expect((blocks[1] as ToolItem).progress).toEqual(['12 passing', '214 passing']);
  });

  it('marks failed and denied tools', () => {
    seq = 0;
    const blocks = buildTranscript(
      [
        call('a', 'Bash', 'Bash tsc'),
        result('a', 'Bash', { ok: false, output: 'error TS2339' }),
        ev({ kind: 'assistant', text: '-' }),
        call('b', 'Fetch', 'Fetch evil.example'),
        result('b', 'Fetch', { ok: false, output: 'denied by owner' }),
      ],
      false,
    );
    expect((blocks[0] as ToolItem).status).toBe('failed');
    expect((blocks[2] as ToolItem).status).toBe('denied');
  });

  it('closes a finished turn with a files-changed summary (and not while the turn is still running)', () => {
    seq = 0;
    const turn = [
      ev({ kind: 'user', text: 'edit' }),
      call('e', 'Edit', 'Edit a.ts'),
      result('e', 'Edit', { diff: DIFF }),
    ];
    const running = buildTranscript(turn, true);
    expect(running.some((b) => b.kind === 'changes')).toBe(false);
    const done = buildTranscript(turn, false);
    expect(done.at(-1)).toMatchObject({ kind: 'changes', files: 1, added: 2, removed: 1 });
    // A new user message also closes the previous turn.
    const next = buildTranscript([...turn, ev({ kind: 'user', text: 'again' })], true);
    expect(next.map((b) => b.kind)).toEqual(['user', 'tool', 'changes', 'user']);
  });

  it('streams only the newest assistant block while running', () => {
    seq = 0;
    const events = [ev({ kind: 'assistant', text: 'a' }), ev({ kind: 'assistant', text: 'b' })];
    const live = buildTranscript(events, true);
    expect(live.map((b) => b.kind === 'assistant' && b.streaming)).toEqual([false, true]);
    expect(buildTranscript(events, false).some((b) => b.kind === 'assistant' && b.streaming)).toBe(false);
  });

  it('skips usage events and renders a result without its call', () => {
    seq = 0;
    const blocks = buildTranscript(
      [ev({ kind: 'usage', text: '$1' }), result('z', 'Read', { title: 'Read x' })],
      false,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'tool', status: 'ok', target: 'x' });
  });

  it('concatenates every diff for the session sheet', () => {
    seq = 0;
    const d = sessionDiff([result('a', 'Edit', { diff: DIFF }), result('b', 'Edit', { diff: DIFF })]);
    expect(d.split('diff --git')).toHaveLength(3);
  });
});

describe('tool helpers', () => {
  it('splits titles into verb and mono target', () => {
    expect(splitTitle('Bash', 'Bash npm test')).toEqual({ verb: 'Bash', target: 'npm test' });
    expect(splitTitle('Read')).toEqual({ verb: 'Read', target: '' });
    expect(splitTitle('Fetch', 'GET api.github.com')).toEqual({
      verb: 'Fetch',
      target: 'GET api.github.com',
    });
  });

  it('formats durations', () => {
    expect(duration(120)).toBe('0.1s');
    expect(duration(42_000)).toBe('42s');
    expect(duration(64_000)).toBe('1m 04s');
    expect(duration(12 * 60_000)).toBe('12m');
  });

  it('summarises runs', () => {
    seq = 0;
    const blocks = buildTranscript(
      [
        call('a', 'Read', 'Read a', 0),
        result('a', 'Read', {}, 1),
        call('b', 'Edit', 'Edit b', 2),
        result('b', 'Edit', { diff: DIFF }, 3),
        call('c', 'Bash', 'Bash x', 4),
        result('c', 'Bash', { ok: false }, 64),
      ],
      false,
    );
    const run = blocks[0];
    if (run?.kind !== 'run') throw new Error('expected run');
    expect(runSummary(run.tools)).toMatchObject({ count: 3, edits: 1, failed: 1, ms: 64_000 });
  });
});

describe('currentActivity', () => {
  const s = { status: 'running', lastActivityAt: at(0) } as const;
  it('prefers a pending approval, then the running tool with its latest progress', () => {
    seq = 0;
    const events = [call('b', 'Bash', 'Bash npm test'), ev({ kind: 'progress', text: '214 passing' })];
    expect(currentActivity(s, events)).toMatchObject({
      kind: 'tool',
      label: 'Bash npm test',
      detail: '214 passing',
    });
    const withAsk = [...events, ev({ kind: 'permission', approvalId: 'apr_1', text: 'git push' })];
    expect(currentActivity(s, withAsk, [{ id: 'apr_1', status: 'pending' }])).toMatchObject({
      kind: 'waiting',
      label: 'git push',
    });
    // Decided approvals don't block.
    expect(currentActivity(s, withAsk, [{ id: 'apr_1', status: 'approved' }])?.kind).toBe('tool');
  });

  it('reports responding / thinking / queued / idle', () => {
    seq = 0;
    expect(currentActivity(s, [ev({ kind: 'assistant', text: 'hi' })])?.kind).toBe('responding');
    expect(currentActivity(s, [ev({ kind: 'user', text: 'hi' })])?.kind).toBe('thinking');
    expect(currentActivity({ ...s, status: 'queued' }, [])?.kind).toBe('queued');
    expect(currentActivity({ ...s, status: 'ended' }, [])).toBeNull();
  });
});

describe('list helpers', () => {
  const mk = (
    id: string,
    agent: string,
    status: SessionView['status'],
    last: string,
    started = last,
  ): SessionView => ({
    id,
    agent,
    channel: 'tg',
    conversationId: 'dm',
    threadId: id,
    title: id,
    status,
    startedAt: started,
    lastActivityAt: last,
    usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
  });
  const now = Date.UTC(2026, 10, 13, 12);
  const today = new Date(now - 3_600_000).toISOString();
  const old = new Date(now - 3 * 86_400_000).toISOString();
  const list = [
    mk('a', 'reviewer', 'running', today, old),
    mk('b', 'reviewer', 'ended', old, new Date(now - 4 * 86_400_000).toISOString()),
    mk('c', 'helpdesk', 'idle', today),
    mk('d', 'reviewer', 'queued', today, today),
  ];

  it('filters by status, needs-you, today and agent', () => {
    const needsYou = new Set(['c']);
    const ids = (f: Parameters<typeof filterSessions>[1]) => filterSessions(list, f).map((s) => s.id);
    expect(ids({ filter: 'live', needsYou, now })).toEqual(['a', 'd']);
    expect(ids({ filter: 'needs-you', needsYou, now })).toEqual(['c']);
    expect(ids({ filter: 'today', needsYou, now })).toEqual(['a', 'c', 'd']);
    expect(ids({ filter: 'all', agent: 'helpdesk', needsYou, now })).toEqual(['c']);
    expect(filterCounts(list, needsYou, undefined, now)).toEqual({
      live: 2,
      'needs-you': 1,
      today: 3,
      all: 4,
    });
  });

  it('groups by agent with the most recently active agent first', () => {
    const g = groupByAgent([list[1]!, list[2]!, list[0]!]);
    expect(g.map((x) => x.agent)).toEqual(['helpdesk', 'reviewer']);
    expect(g[1]!.sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('finds the previous (older) and next (newer) session of the same agent', () => {
    const n = neighbours(list, list[0]);
    expect(n.prev?.id).toBe('b');
    expect(n.next?.id).toBe('d');
    expect(n).toMatchObject({ index: 1, total: 3 });
    expect(neighbours(list, undefined)).toMatchObject({ total: 0 });
  });

  it('matches slash commands only for a single leading token', () => {
    expect(matchSlash('/s').map((c) => c.cmd)).toEqual(['/stop', '/status']);
    expect(matchSlash('/stop now')).toEqual([]);
    expect(matchSlash('hello /stop')).toEqual([]);
  });
});

describe('prose', () => {
  it('parses inline code, bold and links without interpreting HTML', () => {
    expect(parseInline('use `z.email()` **now** see https://x.dev/a. <b>x</b>')).toEqual([
      { t: 'text', v: 'use ' },
      { t: 'code', v: 'z.email()' },
      { t: 'text', v: ' ' },
      { t: 'bold', v: 'now' },
      { t: 'text', v: ' see ' },
      { t: 'link', v: 'https://x.dev/a' },
      { t: 'text', v: '. <b>x</b>' },
    ]);
  });

  it('parses paragraphs, lists and (unterminated) fences', () => {
    const b = parseProse('Done.\n\n- one\n- two\n1. first\n```ts\nconst a = 1;');
    expect(b.map((x) => x.t)).toEqual(['p', 'ul', 'ol', 'code']);
    expect(b[3]).toMatchObject({ lang: 'ts', code: 'const a = 1;', open: true });
  });
});
