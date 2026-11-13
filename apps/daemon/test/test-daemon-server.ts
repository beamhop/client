/**
 * Process entry for the PWA's real-backend e2e suite (`apps/pwa/e2e-real`): runs a test daemon
 * (test-daemon.ts) on BH_E2E_PORT and a small JSON control API on BH_E2E_CONTROL_PORT (loopback
 * only) that Playwright workers use to reset state and drive the fakes:
 *
 *   GET  /info                         → { url, token, home }
 *   POST /reset    { seed?, undoMs? }  → fresh home + daemon on the same port → { url, token, home }
 *   POST /inject   { text, channel?, from?, conversation?, mentionsAgent? } → { id }
 *   GET  /snapshot                     → what the fake channel sent / the fake harness received
 *   POST /advance  { ms }              → move the daemon clock forward and run housekeeping
 *   POST /violation { kind, value }    → a sandbox violation from every live session sandbox
 *
 * Prints one line `BH_E2E_READY {json}` to stdout when listening. Stops on SIGTERM / SIGINT.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { startTestDaemon, type TestDaemon } from './test-daemon.ts';

const port = Number(process.env.BH_E2E_PORT ?? 4600);
const controlPort = Number(process.env.BH_E2E_CONTROL_PORT ?? port + 1);
const staticDir = process.env.BH_E2E_STATIC_DIR;

let td: TestDaemon | undefined;
let busy: Promise<unknown> = Promise.resolve();

const start = async (o: { seed?: boolean; undoMs?: number } = {}) => {
  if (td) await td.stop();
  td = undefined;
  td = await startTestDaemon({
    port,
    ...(staticDir ? { staticDir } : {}),
    ...(o.seed === false ? { seed: false } : {}),
    ...(o.undoMs !== undefined ? { approvalUndoMs: o.undoMs } : {}),
  });
  return info();
};

const info = () => {
  if (!td) throw new Error('daemon not running');
  return { url: td.url, token: td.token, home: td.home };
};

const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? (JSON.parse(s) as Record<string, unknown>) : {};
};

/** Serialise control calls (a reset must not interleave with an inject). */
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = busy.then(fn, fn);
  busy = next.catch(() => undefined);
  return next;
};

const control = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const reply = (status: number, body: unknown) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  void serial(async () => {
    const body = req.method === 'POST' ? await readJson(req) : {};
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /info':
        return info();
      case 'POST /reset':
        return start(body as { seed?: boolean; undoMs?: number });
      case 'POST /inject': {
        if (!td) throw new Error('daemon not running');
        const m = td.inject(body as never);
        return { id: m.id };
      }
      case 'GET /snapshot':
        if (!td) throw new Error('daemon not running');
        return td.snapshot();
      case 'POST /violation':
        if (!td) throw new Error('daemon not running');
        return { sinks: td.violate(body as never) };
      case 'POST /advance':
        if (!td) throw new Error('daemon not running');
        await td.advance(Number(body.ms ?? 0));
        return { offset: td.clock.offset };
      default:
        throw Object.assign(new Error(`no route ${req.method} ${url.pathname}`), { status: 404 });
    }
  }).then(
    (out) => reply(200, out),
    (e: Error & { status?: number }) => reply(e.status ?? 500, { error: e.message }),
  );
});

const shutdown = async () => {
  setTimeout(() => process.exit(1), 5000).unref();
  control.close();
  await td?.stop().catch(() => undefined);
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
// Never outlive the test runner that started us (e.g. a killed Playwright run).
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) void shutdown();
}, 1000).unref();

await start();
await new Promise<void>((r) => control.listen(controlPort, '127.0.0.1', () => r()));
process.stdout.write(
  `BH_E2E_READY ${JSON.stringify({ ...info(), control: `http://127.0.0.1:${controlPort}` })}\n`,
);
