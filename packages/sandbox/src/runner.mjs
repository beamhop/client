// Host-side sandbox runner (plain JS so it runs under bare `node`).
//
//   node runner.mjs <config.json> -- <cmd> [args...]
//
// Initializes srt's SandboxManager in *this* process (so every beamhop sandbox has its own
// proxies and policy, independent of other sessions in the daemon), wraps the command,
// spawns it with inherited stdio and forwards srt violation events as JSON lines to the
// daemon's violation socket. The config file holds no secrets.
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { delimiter, isAbsolute, join } from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

// Set only so the desktop app's Electron binary runs this file as Node; the harness must not inherit it.
delete process.env.ELECTRON_RUN_AS_NODE;

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

/** Absolute path of an executable on PATH (or the path itself when absolute). */
const findExecutable = (name) => {
  const ok = (p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(name)) return ok(name) ? name : undefined;
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
    if (dir && ok(join(dir, name))) return join(dir, name);
  }
  return undefined;
};

/**
 * Shell prefix (Linux) that starts one forwarder per host-loopback port *inside* the sandbox's
 * network namespace: `socat` listens on 127.0.0.1:<port> there and tunnels each connection as
 * `CONNECT 127.0.0.1:<port>` through srt's HTTP proxy, which allows exactly the allow-listed
 * `127.0.0.1:<port>` entries and nothing else (SBX-3). Clients therefore need no proxy support
 * (node `fetch` ignores HTTP_PROXY) and 127.0.0.1 stays in NO_PROXY, so a harness that talks to its
 * own in-sandbox loopback server (opencode) is unaffected.
 *
 * The proxy credential is taken from srt's own $HTTP_PROXY at run time (it never appears in argv).
 * The prefix waits (up to ~3 s) until every forwarder listens, then the caller `exec`s the command;
 * the forwarders die with the sandbox's pid namespace. Forwarders run under srt's seccomp filter,
 * which is fine: they only use AF_INET sockets.
 */
const loopbackForwardScript = (ports, socat) => {
  const hex = ports.map((p) => `*:${p.toString(16).toUpperCase().padStart(4, '0')}`).join('|');
  const lines = [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion
    'if [ -n "${HTTP_PROXY:-}" ]; then',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion
    '_bh_p=${HTTP_PROXY#*://}; _bh_p=${_bh_p%%/*}; _bh_a=',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion (userinfo is `srt.<id>:<hex token>`; the token authenticates)
    'case $_bh_p in *@*) _bh_a=${_bh_p%@*}; _bh_a=",proxyauth=srt:${_bh_a#*:}"; _bh_p=${_bh_p##*@};; esac',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion
    '_bh_pp=${_bh_p##*:}',
    ...ports.map(
      (p) =>
        `${shQuote(socat)} TCP4-LISTEN:${p},bind=127.0.0.1,fork,reuseaddr,backlog=1024 "PROXY:127.0.0.1:127.0.0.1:${p},proxyport=$_bh_pp$_bh_a" </dev/null >/dev/null 2>&1 &`,
    ),
    '_bh_i=0',
    'while [ "$_bh_i" -lt 300 ]; do',
    '  _bh_n=0',
    '  for _bh_f in /proc/net/tcp /proc/net/tcp6; do',
    '    [ -r "$_bh_f" ] || continue',
    '    while read -r _bh_x _bh_l _bh_r _bh_s _bh_y; do',
    `      [ "$_bh_s" = 0A ] && case "$_bh_l" in ${hex}) _bh_n=$((_bh_n + 1));; esac`,
    '    done < "$_bh_f"',
    '  done',
    `  [ "$_bh_n" -ge ${ports.length} ] && break`,
    '  _bh_i=$((_bh_i + 1))',
    '  sleep 0.01 2>/dev/null || :',
    'done',
    'unset _bh_p _bh_a _bh_pp _bh_i _bh_n _bh_f _bh_x _bh_l _bh_r _bh_s _bh_y',
    'fi',
  ];
  return `${lines.join('\n')}\n`;
};

const main = async () => {
  const learning = cfg.learning === true;
  // Learning mode and "allow all" both let every host through the proxy; deny entries, metadata and
  // private addresses are still enforced by srt before this callback is asked.
  const allowAll = cfg.allowAll === true;
  const ask =
    learning || allowAll
      ? async ({ host, port }) => {
          const why = allowAll ? 'allow all' : 'learning';
          send({ line: `allow network-outbound ${host}:${port} (${why})`, allowed: true });
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
  const forwards = (Array.isArray(cfg.forwardPorts) ? cfg.forwardPorts : []).filter(
    (p) => Number.isInteger(p) && p > 0 && p < 65536,
  );
  if (process.platform === 'linux' && forwards.length) {
    // Host-loopback services (broker, MCP bridge) are reached through in-sandbox forwarders on the
    // *same* 127.0.0.1:<port>, so 127.0.0.1 stays in NO_PROXY and the harness's own loopback
    // servers keep working (see loopbackForwardScript).
    const socat = findExecutable(cfg.socatPath || 'socat');
    if (!socat) fail('socat not found (required for host-loopback forwarding)');
    command = `${loopbackForwardScript(forwards, socat)}exec ${command}`;
  } else if (!isWin && typeof cfg.noProxy === 'string') {
    // macOS (no network namespace): there is no place for an in-sandbox forwarder, so the broker on
    // the host loopback is only reachable through srt's proxy: drop 127.0.0.1 from NO_PROXY.
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
