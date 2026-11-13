// A node "harness" that runs inside the real srt sandbox and exercises the whole core loop from the
// inside, like a real coding agent would. Used by core-loop.test.ts. Reads one JSON request per line
// on stdin and answers with beamhop HarnessEvent JSON lines on stdout.
//
//   (a) calls the LLM broker at $OPENAI_BASE_URL with the placeholder key it was given
//   (b) spawns the beamhop-mcp stdio server from SessionSpec.mcpServers and calls tools over MCP
//   (c) runs its own loopback HTTP server inside the sandbox and talks to it (opencode-style),
//       both with node fetch and with curl (which honours the sandbox's proxy env)
//   (d) tries to reach another host-loopback port, directly and explicitly through srt's proxy
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

const out = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);

const get = async (url, init) => {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { error: String(e.cause?.code ?? e.message) };
  }
};

const curl = (args) =>
  new Promise((resolve) => {
    execFile('curl', ['-sS', '-m', '8', ...args], { env: process.env }, (err, stdout, stderr) =>
      resolve({
        code: err ? (err.code ?? 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr).slice(0, 200),
      }),
    );
  });

/** Minimal MCP client over stdio (newline-delimited JSON-RPC), no SDK needed. */
const mcpSession = (server) => {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const pending = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on('line', (l) => {
    try {
      const m = JSON.parse(l);
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    } catch {
      /* not json */
    }
  });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const t = setTimeout(
        () => reject(new Error(`mcp ${method} timed out; stderr: ${stderr.slice(-300)}`)),
        20000,
      );
      pending.set(n, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
      exited.then((code) => reject(new Error(`mcp exited ${code}: ${stderr.slice(-300)}`)));
    });
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  return { rpc, notify, close: () => child.kill('SIGTERM') };
};

const run = async (req) => {
  const results = {};
  // (a) broker
  const base = process.env.OPENAI_BASE_URL;
  results.placeholderKey = (process.env.OPENAI_API_KEY ?? '').slice(0, 6);
  results.broker = base
    ? await get(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] }),
      })
    : { error: 'no OPENAI_BASE_URL' };

  // (b) MCP
  const server = req.mcpServers?.[0];
  if (server) {
    const id = `t-mcp`;
    out({ type: 'tool_call', id, name: 'beamhop.session_status', input: {} });
    const mcp = mcpSession(server);
    try {
      const init = await mcp.rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'loop-harness', version: '0' },
      });
      results.mcpServer = init.result?.serverInfo?.name;
      mcp.notify('notifications/initialized', {});
      const tools = await mcp.rpc('tools/list', {});
      results.mcpTools = (tools.result?.tools ?? []).map((t) => t.name);
      const status = await mcp.rpc('tools/call', { name: 'session_status', arguments: {} });
      results.sessionStatus = status.result?.isError
        ? { error: status.result }
        : status.result?.content?.[0]?.text;
      out({
        type: 'tool_result',
        id,
        ok: !status.result?.isError,
        output: String(results.sessionStatus).slice(0, 200),
      });
      const sent = await mcp.rpc('tools/call', {
        name: 'channel_send',
        arguments: { markdown: `progress note via MCP ${req.nonce}` },
      });
      results.channelSend = sent.result?.isError ? { error: sent.result } : sent.result?.content?.[0]?.text;
    } catch (e) {
      results.mcpError = String(e.message ?? e);
    } finally {
      mcp.close();
    }
  }

  // (c) own loopback server inside the sandbox
  const own = createServer((_q, r) => r.end('own-loopback'));
  await new Promise((r) => own.listen(0, '127.0.0.1', r));
  const ownPort = own.address().port;
  results.ownFetch = await get(`http://127.0.0.1:${ownPort}/`);
  results.ownCurl = await curl([`http://127.0.0.1:${ownPort}/`]);
  own.close();

  // (d) some other host-loopback service
  results.otherFetch = await get(`http://127.0.0.1:${req.otherPort}/`);
  results.otherCurlProxy = await curl([
    '--proxy',
    process.env.HTTP_PROXY ?? '',
    `http://127.0.0.1:${req.otherPort}/`,
  ]);
  results.otherCurlEnv = await curl(['--noproxy', '', `http://127.0.0.1:${req.otherPort}/`]);
  return results;
};

createInterface({ input: process.stdin }).on('line', async (line) => {
  const req = JSON.parse(line);
  out({ type: 'progress', message: 'probing' });
  const results = await run(req);
  out({ type: 'text', delta: `results ${JSON.stringify(results)}` });
  out({ type: 'done', stopReason: 'end_turn' });
});
