import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSafeFetch, isBlockedAddress, type LookupAll } from '../src/safe-fetch.ts';

let server: Server;
let port = 0;
const hits: { url: string; host: string | undefined }[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void = (_q, r) => r.end('ok');

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push({ url: req.url ?? '', host: req.headers.host });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

/** DNS stub: names → addresses. */
const stub =
  (map: Record<string, string[]>): LookupAll =>
  async (host) => {
    const a = map[host];
    if (!a) throw new Error('ENOTFOUND');
    return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

/** Only the exact test server address is allowed (stands in for "a public address"). */
const onlyLoopback1 = (a: string) => a !== '127.0.0.1';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd00:ec2::254',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    '2001::1',
    '2001:db8::1',
    'ff02::1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
});

describe('createSafeFetch', () => {
  it('refuses loopback IP literals and localhost without connecting', async () => {
    const f = createSafeFetch({ allowedPorts: [] });
    const before = hits.length;
    for (const u of [
      `http://127.0.0.1:${port}/x`,
      `http://localhost:${port}/x`,
      `http://[::1]:${port}/x`,
      `http://[::ffff:127.0.0.1]:${port}/x`,
      `http://2130706433:${port}/x`,
      `http://0x7f.1:${port}/x`,
    ]) {
      await expect(f.fetch(u), u).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(hits.length).toBe(before);
  });

  it('refuses metadata and private targets reached through DNS, including mixed answers', async () => {
    const f = createSafeFetch({
      allowedPorts: [],
      lookup: stub({
        'meta.test': ['169.254.169.254'],
        'lan.test': ['192.168.0.10'],
        'mixed.test': ['8.8.8.8', '127.0.0.1'],
        'v6.test': ['fd00:ec2::254'],
      }),
    });
    for (const h of ['meta.test', 'lan.test', 'mixed.test', 'v6.test'])
      await expect(f.fetch(`http://${h}:${port}/`)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('connects to the checked address and keeps the host name', async () => {
    handler = (_q, r) => r.end('hello');
    const f = createSafeFetch({
      allowedPorts: [],
      lookup: stub({ 'files.test': ['127.0.0.1'] }),
      isBlocked: onlyLoopback1,
    });
    const res = await f.fetch(`http://files.test:${port}/a.txt?x=1`);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('hello');
    expect(hits.at(-1)).toEqual({ url: '/a.txt?x=1', host: `files.test:${port}` });
  });

  it('re-checks every redirect hop', async () => {
    handler = (req, res) => {
      if (req.url === '/to-meta') res.writeHead(302, { location: `http://meta.test:${port}/` }).end();
      else if (req.url === '/to-lo2') res.writeHead(301, { location: `http://127.0.0.2:${port}/` }).end();
      else if (req.url === '/to-ok') res.writeHead(307, { location: '/final' }).end();
      else if (req.url === '/loop') res.writeHead(302, { location: '/loop' }).end();
      else res.end('final');
    };
    const f = createSafeFetch({
      allowedPorts: [],
      lookup: stub({ 'files.test': ['127.0.0.1'], 'meta.test': ['169.254.169.254'] }),
      isBlocked: (a) => onlyLoopback1(a),
      maxRedirects: 3,
    });
    await expect(f.fetch(`http://files.test:${port}/to-meta`)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.fetch(`http://files.test:${port}/to-lo2`)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.fetch(`http://files.test:${port}/loop`)).rejects.toThrow(/too many redirects/);
    expect(await (await f.fetch(`http://files.test:${port}/to-ok`)).text()).toBe('final');
  });

  it('refuses bad schemes, credentials and unexpected ports', async () => {
    const f = createSafeFetch();
    await expect(f.fetch('file:///etc/passwd')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.fetch('ftp://example.com/x')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.fetch('https://u:p@example.com/')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.fetch('http://example.com:6379/')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.fetch('not a url')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('enforces the size limit (declared and streamed)', async () => {
    const f = createSafeFetch({
      allowedPorts: [],
      lookup: stub({ 'files.test': ['127.0.0.1'] }),
      isBlocked: onlyLoopback1,
      maxBytes: 1000,
    });
    handler = (_q, r) => r.writeHead(200, { 'content-length': '5000' }).end('x'.repeat(5000));
    await expect(f.fetch(`http://files.test:${port}/big`)).rejects.toThrow(/exceeds 1000 bytes/);
    handler = (_q, r) => {
      r.writeHead(200);
      r.write('x'.repeat(800));
      r.end('y'.repeat(800));
    };
    await expect(f.fetch(`http://files.test:${port}/chunked`)).rejects.toThrow(/exceeds 1000 bytes/);
    await expect(f.fetch(`http://files.test:${port}/chunked`, { maxBytes: 2000 })).resolves.toBeDefined();
  });

  it('times out slow servers', async () => {
    handler = () => {
      /* never answer */
    };
    const f = createSafeFetch({
      allowedPorts: [],
      lookup: stub({ 'files.test': ['127.0.0.1'] }),
      isBlocked: onlyLoopback1,
      timeoutMs: 150,
    });
    await expect(f.fetch(`http://files.test:${port}/slow`)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('downloads atomically and leaves nothing behind on failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-sf-'));
    try {
      const f = createSafeFetch({
        allowedPorts: [],
        lookup: stub({ 'files.test': ['127.0.0.1'] }),
        isBlocked: onlyLoopback1,
        maxBytes: 100,
      });
      handler = (_q, r) => r.end('file body');
      expect(await f.download(`http://files.test:${port}/f`, join(dir, 'a'))).toBe(9);
      expect(readFileSync(join(dir, 'a'), 'utf8')).toBe('file body');
      handler = (_q, r) => r.end('z'.repeat(500));
      await expect(f.download(`http://files.test:${port}/f`, join(dir, 'b'))).rejects.toThrow(/exceeds/);
      handler = (_q, r) => r.writeHead(404).end('nope');
      await expect(f.download(`http://files.test:${port}/f`, join(dir, 'c'))).rejects.toThrow(/HTTP 404/);
      expect(existsSync(join(dir, 'b'))).toBe(false);
      expect(readdirSync(dir)).toEqual(['a']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
