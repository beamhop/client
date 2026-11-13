// Fake ACP agent for tests. Speaks raw newline-delimited JSON-RPC 2.0 on stdio.
// Prompt text drives behavior: "tool write:<path>", "read:<path>", "hang", "crash", "echo-setup", default → "pong".
let buf = '';
let nextId = 1000;
const pending = new Map();
let session = null;
let cancelHang = null;

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
const update = (u) => send({ method: 'session/update', params: { sessionId: session.id, update: u } });
const say = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

if (process.argv.includes('--version')) {
  process.stdout.write('fake-acp 1.2.3\n');
  process.exit(0);
}
if (process.env.FAKE_ACP_SILENT === '1') {
  // never answer: exercise timeouts
  process.stdin.resume();
} else {
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
}

async function handle(m) {
  if (m.method === undefined) {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(m.error) : p.resolve(m.result);
    }
    return;
  }
  try {
    const result = await dispatch(m.method, m.params ?? {});
    if (m.id !== undefined) send({ id: m.id, result: result ?? null });
  } catch (e) {
    if (m.id !== undefined) send({ id: m.id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
}

async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } },
        agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '1.2.3' },
        authMethods: [],
      };
    case 'session/new':
      session = { id: 'sess-1', cwd: params.cwd, mcpServers: params.mcpServers };
      return { sessionId: session.id };
    case 'session/load':
      session = { id: params.sessionId, cwd: params.cwd, mcpServers: params.mcpServers, loaded: true };
      update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old prompt' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } });
      return {};
    case 'session/cancel':
      cancelHang?.();
      return;
    case 'session/prompt':
      return prompt(params);
    default:
      throw new Error(`unknown method ${method}`);
  }
}

async function prompt(params) {
  const text = params.prompt
    .map((b) => (b.type === 'text' ? b.text : `[${b.type}:${b.uri ?? b.mimeType ?? ''}]`))
    .join(' ');
  if (text.includes('crash')) process.exit(3);
  if (text.includes('hang')) {
    say('waiting');
    await new Promise((r) => {
      cancelHang = r;
    });
    return { stopReason: 'cancelled' };
  }
  if (text.includes('echo-setup')) {
    say(
      JSON.stringify({
        cwd: session.cwd,
        mcpServers: session.mcpServers,
        loaded: !!session.loaded,
        prompt: text,
      }),
    );
    return { stopReason: 'end_turn' };
  }
  const read = /read:(\S+)/.exec(text);
  if (read) {
    try {
      const r = await request('fs/read_text_file', { sessionId: session.id, path: read[1] });
      say(`content=${r.content}`);
    } catch (e) {
      say(`read-error=${e.message}`);
    }
    return { stopReason: 'end_turn' };
  }
  // "acp-tool {json}": one nameless ACP tool call (kind/title/rawInput from the JSON) + permission.
  const generic = /^acp-tool (\{[\s\S]*\})$/.exec(text.trim());
  if (generic) {
    const tc = JSON.parse(generic[1]);
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-g', status: 'pending', ...tc });
    const perm = await request('session/request_permission', {
      sessionId: session.id,
      toolCall: { toolCallId: 'tc-g', ...tc },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const ok = perm.outcome.outcome === 'selected' && perm.outcome.optionId === 'allow';
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-g', status: ok ? 'completed' : 'failed' });
    say(ok ? 'tool-allowed' : 'tool-denied');
    return { stopReason: 'end_turn' };
  }
  const write = /write:(\S+)/.exec(text);
  if (text.includes('tool') && write) {
    update({
      sessionUpdate: 'plan',
      entries: [{ content: 'write the file', priority: 'high', status: 'in_progress' }],
    });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: `Write ${write[1]}`,
      kind: 'edit',
      status: 'pending',
      rawInput: { path: write[1], content: 'hello' },
    });
    const perm = await request('session/request_permission', {
      sessionId: session.id,
      toolCall: {
        toolCallId: 'tc-1',
        title: `Write ${write[1]}`,
        kind: 'edit',
        rawInput: { path: write[1] },
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    if (perm.outcome.outcome === 'selected' && perm.outcome.optionId !== 'reject') {
      try {
        await request('fs/write_text_file', { sessionId: session.id, path: write[1], content: 'hello' });
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
          content: [
            { type: 'diff', path: write[1], oldText: null, newText: 'hello' },
            { type: 'content', content: { type: 'text', text: 'wrote 5 bytes' } },
          ],
        });
        say(`allowed:${perm.outcome.optionId}`);
      } catch (e) {
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: e.message } }],
        });
        say('write-failed');
      }
    } else {
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'failed' });
      say('denied');
    }
    return { stopReason: 'end_turn' };
  }
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
  say('po');
  say('ng');
  update({
    sessionUpdate: 'usage_update',
    used: 120,
    size: 200000,
    cost: { amount: 0.0012, currency: 'USD' },
  });
  return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
}
