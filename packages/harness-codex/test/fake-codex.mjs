// Fake `codex`: `app-server` (JSON-RPC without "jsonrpc" field) and `exec --json` modes.
const argv = process.argv.slice(2);
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
if (argv.includes('--version')) {
  console.log('codex-cli 0.167.2');
  process.exit(0);
}

if (argv.includes('exec')) {
  const prompt = argv[argv.indexOf('--') + 1] ?? '';
  const ri = argv.indexOf('resume');
  const tid = ri >= 0 ? argv[ri + 1] : 'thr-exec-1';
  out({ type: 'thread.started', thread_id: tid });
  out({ type: 'turn.started' });
  if (prompt.includes('fail')) {
    out({ type: 'turn.failed', error: { message: 'quota exceeded' } });
    process.exit(1);
  }
  if (prompt.includes('hang')) {
    process.on('SIGINT', () => process.exit(130));
    setInterval(() => {}, 1000);
  } else {
    out({
      type: 'item.started',
      item: { id: 'c1', type: 'command_execution', command: 'ls', status: 'in_progress' },
    });
    out({
      type: 'item.completed',
      item: {
        id: 'c1',
        type: 'command_execution',
        command: 'ls',
        aggregated_output: 'a\nb',
        exit_code: 0,
        status: 'completed',
      },
    });
    out({
      type: 'item.completed',
      item: {
        id: 'm1',
        type: 'agent_message',
        text: prompt.includes('echo') ? JSON.stringify(argv) : 'pong',
      },
    });
    out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } });
    process.exit(0);
  }
} else {
  let buf = '';
  let nextId = 1;
  const waiters = new Map();
  let thread = null;
  let hang = null;
  let total = { inputTokens: 0, outputTokens: 0 };
  const req = (method, params) =>
    new Promise((res) => {
      const id = `s${nextId++}`;
      waiters.set(id, res);
      out({ id, method, params });
    });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) void handle(JSON.parse(line));
      i = buf.indexOf('\n');
    }
  });
  const note = (method, params) => out({ method, params: { threadId: thread?.id, ...params } });
  async function handle(m) {
    if ('jsonrpc' in m) {
      out({ id: m.id, error: { code: -32600, message: 'unexpected jsonrpc field' } });
      return;
    }
    if (m.method === undefined) {
      waiters.get(m.id)?.(m.result);
      return;
    }
    const ok = (result) => out({ id: m.id, result });
    switch (m.method) {
      case 'initialize':
        return ok({ userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' });
      case 'initialized':
        return;
      case 'thread/start':
        thread = { id: 'thr-1', params: m.params };
        return ok({ thread: { id: 'thr-1' }, model: m.params.model ?? 'gpt-5' });
      case 'thread/resume':
        thread = { id: m.params.threadId, params: m.params, resumed: true };
        return ok({ thread: { id: m.params.threadId } });
      case 'turn/interrupt':
        ok({});
        hang?.();
        return;
      case 'turn/start':
        break;
      default:
        return out({ id: m.id, error: { code: -32601, message: 'nope' } });
    }
    const text = m.params.input.find((x) => x.type === 'text')?.text ?? '';
    const turnId = `turn-${nextId++}`;
    ok({ turn: { id: turnId, status: 'inProgress', items: [] } });
    note('turn/started', { turn: { id: turnId } });
    const done = (status, error = null) =>
      note('turn/completed', { turn: { id: turnId, status, error, items: [] } });
    if (text.includes('crash')) process.exit(5);
    if (text.includes('hang')) {
      note('item/agentMessage/delta', { turnId, itemId: 'm0', delta: 'working' });
      await new Promise((r) => {
        hang = r;
      });
      return done('interrupted');
    }
    if (text.includes('cmd')) {
      const item = {
        type: 'commandExecution',
        id: 'cmd1',
        command: 'rm -rf build',
        cwd: thread.params.cwd,
        status: 'inProgress',
      };
      note('item/started', { turnId, item });
      const r = await req('item/commandExecution/requestApproval', {
        threadId: thread.id,
        turnId,
        itemId: 'cmd1',
        command: 'rm -rf build',
        cwd: thread.params.cwd,
        startedAtMs: 0,
      });
      const accepted = r.decision === 'accept' || r.decision === 'acceptForSession';
      note('item/completed', {
        turnId,
        item: {
          ...item,
          status: accepted ? 'completed' : 'declined',
          exitCode: accepted ? 0 : null,
          aggregatedOutput: accepted ? 'removed' : null,
        },
      });
      note('item/agentMessage/delta', { turnId, itemId: 'm1', delta: `decision:${r.decision}` });
      return done('completed');
    }
    if (text.includes('patch')) {
      const item = {
        type: 'fileChange',
        id: 'fc1',
        changes: [{ path: 'a.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-x\n+y' }],
        status: 'inProgress',
      };
      note('item/started', { turnId, item });
      const r = await req('item/fileChange/requestApproval', {
        threadId: thread.id,
        turnId,
        itemId: 'fc1',
        startedAtMs: 0,
        reason: 'edit a.txt',
      });
      note('item/completed', {
        turnId,
        item: { ...item, status: r.decision === 'decline' ? 'declined' : 'completed' },
      });
      return done('completed');
    }
    if (text.includes('fail')) {
      note('error', { error: { message: 'rate limited' }, willRetry: true, turnId });
      return done('failed', { message: 'usage limit reached' });
    }
    if (text.includes('echo')) {
      note('item/completed', {
        turnId,
        item: {
          type: 'agentMessage',
          id: 'm2',
          text: JSON.stringify({ thread, argv, input: m.params.input }),
        },
      });
      return done('completed');
    }
    note('item/reasoning/summaryTextDelta', { turnId, itemId: 'r1', delta: 'thinking', summaryIndex: 0 });
    note('item/started', { turnId, item: { type: 'agentMessage', id: 'm3', text: '' } });
    note('item/agentMessage/delta', { turnId, itemId: 'm3', delta: 'po' });
    note('item/agentMessage/delta', { turnId, itemId: 'm3', delta: 'ng' });
    note('item/completed', { turnId, item: { type: 'agentMessage', id: 'm3', text: 'pong' } });
    note('turn/plan/updated', { turnId, plan: [{ step: 'answer', status: 'completed' }] });
    total = { inputTokens: total.inputTokens + 100, outputTokens: total.outputTokens + 7 };
    note('thread/tokenUsage/updated', { turnId, tokenUsage: { total, last: total } });
    note('thread/tokenUsage/updated', {
      threadId: 'other-thread',
      turnId,
      tokenUsage: { total: { inputTokens: 9999, outputTokens: 9999 } },
    });
    done('completed');
  }
}
