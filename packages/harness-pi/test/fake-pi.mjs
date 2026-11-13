// Fake `pi --mode rpc`: JSONL commands on stdin, responses/events on stdout.
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('0.73.1');
  process.exit(0);
}
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const uiWaiters = new Map();
let abortHang = null;
let buf = '';
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

const assistant = (text, stopReason = 'stop') => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason,
  usage: { input: 50, output: 5, cost: { total: 0.0001 } },
  ...(stopReason === 'error' ? { errorMessage: '401 invalid key' } : {}),
});
const streamText = (text) => {
  out({ type: 'message_start', message: { role: 'assistant' } });
  for (const ch of [text.slice(0, 2), text.slice(2)]) {
    out({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ch } });
  }
};

async function handle(m) {
  if (m.type === 'extension_ui_response') {
    uiWaiters.get(m.id)?.(m);
    return;
  }
  const respond = (extra) => out({ id: m.id, type: 'response', command: m.type, success: true, ...extra });
  switch (m.type) {
    case 'get_state':
      return respond({ data: { sessionId: 'pi-sess-1', sessionFile: '/sessions/pi-sess-1.jsonl', argv } });
    case 'abort':
      respond({});
      abortHang?.();
      return;
    case 'prompt':
      break;
    default:
      return out({ id: m.id, type: 'response', command: m.type, success: false, error: 'unknown' });
  }
  const text = m.message;
  if (text.includes('reject')) return out({ id: m.id, type: 'response', command: 'prompt', success: false, error: 'busy' });
  respond({});
  out({ type: 'agent_start' });
  if (text.includes('crash')) process.exit(4);
  if (text.includes('echo')) {
    streamText(JSON.stringify({ text, images: m.images?.length ?? 0, argv }));
    out({ type: 'message_end', message: assistant('') });
  } else if (text.includes('hang')) {
    streamText('wait');
    await new Promise((r) => {
      abortHang = r;
    });
    out({ type: 'message_end', message: assistant('', 'aborted') });
  } else if (text.includes('fail')) {
    out({ type: 'message_end', message: assistant('', 'error') });
  } else if (text.includes('tool')) {
    out({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'edit', args: { path: 'a.txt' } });
    let allowed = true;
    if (argv.includes('--extension')) {
      const id = `ui-${Math.random()}`;
      const payload = JSON.stringify({ toolCallId: 'call_1', tool: 'edit', input: { path: 'a.txt' } });
      out({ type: 'extension_ui_request', id, method: 'confirm', title: `beamhop-permission:${payload}`, message: 'Allow edit?' });
      const r = await new Promise((res) => uiWaiters.set(id, res));
      allowed = r.confirmed === true;
    }
    out({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'edit',
      result: allowed
        ? { content: [{ type: 'text', text: 'edited' }], details: { diff: '--- a/a.txt\n+++ b/a.txt\n-x\n+y' } }
        : { content: [{ type: 'text', text: 'denied by the owner' }] },
      isError: !allowed,
    });
    streamText(allowed ? 'did-it' : 'blocked');
    out({ type: 'message_end', message: assistant('') });
  } else {
    out({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } });
    streamText('pong');
    out({ type: 'message_end', message: { role: 'user' } });
    out({ type: 'message_end', message: assistant('pong') });
  }
  out({ type: 'agent_end', messages: [] });
}
