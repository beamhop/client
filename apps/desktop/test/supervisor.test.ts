import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DaemonState, DaemonSupervisor, explainStartFailure } from '../src/supervisor.ts';

/** A fake beamhopd: serves /healthz on the given port until SIGTERM (or exits with a message). */
const FAKE_DAEMON = `
const http = require('node:http');
const [port, mode] = process.argv.slice(2);
if (mode === 'crash') { console.error('listen EADDRINUSE: address already in use 127.0.0.1:' + port); process.exit(1); }
const srv = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, {'content-type':'application/json'}); res.end('{"ok":true}'); }
  else { res.writeHead(404); res.end(); }
}).listen(Number(port), '127.0.0.1', () => console.log('fake daemon up'));
process.on('SIGTERM', () => { console.log('fake daemon stopping'); srv.close(() => process.exit(0)); });
`;

const freePort = async (): Promise<number> => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
};

let dir: string;
let script: string;
let tokenFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bh-desktop-'));
  script = join(dir, 'fake-daemon.cjs');
  writeFileSync(script, FAKE_DAEMON);
  tokenFile = join(dir, 'api-token');
  writeFileSync(tokenFile, 'tok_abc\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const make = (port: number, mode = 'ok') =>
  new DaemonSupervisor({
    url: `http://127.0.0.1:${port}`,
    command: process.execPath,
    args: [script, String(port), mode],
    env: process.env,
    tokenFile,
    logFile: join(dir, 'logs', 'daemon.log'),
    startTimeoutMs: 10_000,
    stopTimeoutMs: 5_000,
    pollMs: 100,
  });

describe('DaemonSupervisor', () => {
  it('starts its own daemon when none answers, and stops it', async () => {
    const port = await freePort();
    const sup = make(port);
    const states: DaemonState[] = [];
    sup.on('state', (s) => states.push(s));
    expect(await sup.ensure()).toBe('owned');
    expect(sup.owned).toBe(true);
    expect(await sup.healthy()).toBe(true);
    await sup.stop();
    expect(await sup.healthy()).toBe(false);
    expect(states).toEqual(['starting', 'running', 'stopping', 'stopped']);
  });

  it('attaches to a daemon that is already running and leaves it alone on stop', async () => {
    const port = await freePort();
    const external: Server = createServer((req, res) => {
      res.writeHead(req.url === '/healthz' ? 200 : 404, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => external.listen(port, '127.0.0.1', r));
    try {
      const sup = make(port);
      expect(await sup.ensure()).toBe('external');
      expect(sup.owned).toBe(false);
      expect(sup.state).toBe('external');
      await sup.stop();
      expect(sup.state).toBe('stopped');
      // Still up: the app never stops a daemon it did not start.
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.ok).toBe(true);
    } finally {
      await new Promise<void>((r) => external.close(() => r()));
    }
  });

  it('does not mistake another program on the port for a daemon', async () => {
    const port = await freePort();
    const other = createServer((_req, res) => res.writeHead(200).end('hello'));
    await new Promise<void>((r) => other.listen(port, '127.0.0.1', r));
    try {
      const sup = make(port);
      expect(await sup.healthy()).toBe(false);
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  it('reports a start failure with an actionable message and the log tail', async () => {
    const port = await freePort();
    const sup = make(port, 'crash');
    await expect(sup.ensure()).rejects.toThrow(/Another program is using 127\.0\.0\.1:\d+/);
    expect(sup.state).toBe('failed');
    expect(sup.lastError).toMatch(/EADDRINUSE/);
    expect(sup.owned).toBe(false);
  });

  it('restarts a daemon that crashes', async () => {
    const port = await freePort();
    const sup = make(port);
    await sup.ensure();
    const running = new Promise<void>((resolve) => {
      let sawStart = false;
      sup.on('state', (s) => {
        if (s === 'starting') sawStart = true;
        if (s === 'running' && sawStart) resolve();
      });
    });
    // Simulate a crash: kill the child behind the supervisor's back.
    (sup as unknown as { child: { kill(s: string): void } }).child.kill('SIGKILL');
    await running;
    expect(await sup.healthy()).toBe(true);
    await sup.stop();
  });

  it('builds the signed-in UI URL from the token file', () => {
    const sup = make(7878);
    expect(sup.uiUrl()).toBe('http://127.0.0.1:7878/#token=tok_abc');
  });
});

describe('explainStartFailure', () => {
  it('names the common causes', () => {
    expect(explainStartFailure('Error: listen EADDRINUSE', 'http://127.0.0.1:7878')).toMatch(
      /127\.0\.0\.1:7878/,
    );
    expect(explainStartFailure('another beamhop daemon is running (pid 4)', 'http://127.0.0.1:7878')).toMatch(
      /already running on a different port/,
    );
    expect(explainStartFailure('', 'http://127.0.0.1:7878')).toBe('The beamhop daemon did not start.');
  });
});
