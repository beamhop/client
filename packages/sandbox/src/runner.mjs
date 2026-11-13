// Host-side sandbox runner (plain JS so it runs under bare `node`).
//
//   node runner.mjs <config.json> -- <cmd> [args...]
//
// Initializes srt's SandboxManager in *this* process (so every beamhop sandbox has its own
// proxies and policy, independent of other sessions in the daemon), wraps the command,
// spawns it with inherited stdio and forwards srt violation events as JSON lines to the
// daemon's violation socket. The config file holds no secrets.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

const fail = (msg) => {
  process.stderr.write(`beamhop-sandbox: ${msg}\n`);
  process.exit(125);
};

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep !== 1 || argv.length < 3) fail('usage: runner.mjs <config.json> -- <cmd> [args...]');
const cfg = JSON.parse(readFileSync(argv[0], 'utf8'));
const [cmd, ...args] = argv.slice(2);

// ── violation channel ──
let sock;
const pending = [];
const send = (obj) => {
  const line = `${JSON.stringify(obj)}\n`;
  if (sock?.writable) sock.write(line);
  else pending.push(line);
};
if (cfg.violationSocket) {
  sock = connect(cfg.violationSocket);
  sock.on('connect', () => {
    for (const l of pending.splice(0)) sock.write(l);
  });
  sock.on('error', () => {
    sock = undefined;
  });
  sock.unref();
}

const shQuote = (s) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const winQuote = (s) => (/^[A-Za-z0-9_./:=@%+,\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

const main = async () => {
  const learning = cfg.learning === true;
  const ask = learning
    ? async ({ host, port }) => {
        send({ line: `allow network-outbound ${host}:${port} (learning)`, allowed: true });
        return true;
      }
    : undefined;
  await SandboxManager.initialize(cfg.srt, ask, true);

  const store = SandboxManager.getSandboxViolationStore();
  let seen = store.getTotalCount();
  store.subscribe(() => {
    const total = store.getTotalCount();
    const fresh = total - seen;
    seen = total;
    if (fresh <= 0) return;
    for (const v of store.getViolations(fresh)) send({ line: v.line });
  });

  const isWin = process.platform === 'win32';
  let command = (isWin ? [cmd, ...args].map(winQuote) : [cmd, ...args].map(shQuote)).join(' ');
  if (!isWin && typeof cfg.noProxy === 'string') {
    // srt routes 127.0.0.1 direct (NO_PROXY); the broker lives on the *host* loopback, which
    // is only reachable through srt's proxy, so drop it from NO_PROXY for this command.
    command = `NO_PROXY=${shQuote(cfg.noProxy)} no_proxy=${shQuote(cfg.noProxy)} ${command}`;
  }
  const options = { commandId: cfg.commandId };

  let child;
  if (isWin) {
    const w = await SandboxManager.wrapWithSandboxArgv(
      command,
      undefined,
      undefined,
      undefined,
      undefined,
      options,
    );
    child = spawn(w.argv[0], w.argv.slice(1), { shell: false, stdio: 'inherit', env: w.env });
  } else {
    const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, undefined, undefined, options);
    // On Linux srt returns `bwrap --die-with-parent ...`. `exec` it so bwrap's parent is *this*
    // runner, not an intermediate /bin/sh: otherwise a SIGKILL of the runner (daemon crash, hard
    // stop) orphans the shell, bwrap's parent stays alive and the whole sandbox keeps running.
    const direct = process.platform === 'linux' && /^bwrap\s/.test(wrapped);
    child = spawn(direct ? `exec ${wrapped}` : wrapped, { shell: true, stdio: 'inherit' });
  }

  const forward = (sig) => () => child.kill(sig);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, forward(sig));
  let timer;
  if (cfg.timeoutMs > 0) {
    timer = setTimeout(() => {
      send({ line: 'timeout session exceeded maxSessionMinutes' });
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, cfg.timeoutMs);
    timer.unref();
  }

  child.on('error', (e) => fail(`spawn failed: ${e.message}`));
  child.on('exit', async (code, signal) => {
    clearTimeout(timer);
    try {
      SandboxManager.cleanupAfterCommand();
    } catch {}
    // Give the proxy/monitor a moment to flush the last violations.
    await new Promise((r) => setTimeout(r, 50));
    if (sock?.writable) await new Promise((r) => sock.end(r));
    try {
      await SandboxManager.reset();
    } catch {}
    const signals = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
    process.exit(signal ? 128 + (signals[signal] ?? 1) : (code ?? 0));
  });
};

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
