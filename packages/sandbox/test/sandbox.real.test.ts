import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BeamhopSandbox, compilePolicy, createSandbox, type Violation } from '../src/index.ts';
import { hasBwrap, makeFixture, NO_BWRAP_REASON, runIn } from './helpers.ts';

// Real, unmocked tests: these run srt + bubblewrap on this machine.
describe.skipIf(!hasBwrap)(
  `real srt sandbox (linux) ${hasBwrap ? '' : `— skipped: ${NO_BWRAP_REASON}`}`,
  () => {
    const fx = makeFixture();
    const sourceEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      SECRET_TOKEN: 'sk-should-not-leak',
    };
    const policy = compilePolicy(
      'workspace',
      [
        { path: fx.ws, mode: 'rw' },
        { path: fx.ro, mode: 'ro' },
      ],
      {},
      { home: fx.home },
    );
    let sbx: BeamhopSandbox;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
      sbx = await createSandbox(policy, { backend: 'srt', sourceEnv, env: { HOME: fx.home }, home: fx.home });
      server = createServer((_req, res) => res.end('hello-from-host'));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
      await sbx?.close();
      server?.close();
      rmSync(fx.root, { recursive: true, force: true });
    });

    it('uses the srt backend and denies ~/.ssh', async () => {
      expect(sbx.backend).toBe('srt');
      expect(sbx.srtConfig?.filesystem.denyRead).toContain(join(fx.home, '.ssh'));
    });

    it('cannot read a fake ssh key in HOME', async () => {
      const r = await runIn(sbx, 'cat', [join(fx.home, '.ssh', 'id_x')]);
      expect(r.code).not.toBe(0);
      expect(r.stdout).not.toContain('FAKE-PRIVATE-KEY');
    });

    it('can read a ro mount but not write it', async () => {
      const r = await runIn(sbx, 'cat', [join(fx.ro, 'readme.txt')]);
      expect(r.stdout).toContain('read only');
      const w = await runIn(sbx, 'sh', ['-c', `echo x > ${join(fx.ro, 'new.txt')}`]);
      expect(w.code).not.toBe(0);
      expect(existsSync(join(fx.ro, 'new.txt'))).toBe(false);
    });

    it('writing outside rw mounts fails', async () => {
      const target = join(fx.outside, 'pwned.txt');
      const r = await runIn(sbx, 'sh', ['-c', `echo pwned > ${target}`]);
      expect(r.code).not.toBe(0);
      expect(existsSync(target)).toBe(false);
      await new Promise((res) => setTimeout(res, 100));
      // Learning-mode signal: srt's seccomp observer reports the refused write.
      expect(sbx.violations()).toContainEqual(expect.objectContaining({ kind: 'fs.write', value: target }));
    });

    it('writing inside an rw mount succeeds', async () => {
      const target = join(fx.ws, 'ok.txt');
      const r = await runIn(sbx, 'sh', ['-c', `echo fine > ${target}`]);
      expect(r.code).toBe(0);
      expect(readFileSync(target, 'utf8')).toBe('fine\n');
    });

    it('blocks https to a host that is not allowlisted and reports a net.allow violation', async () => {
      const seen: Violation[] = [];
      const off = sbx.onViolation((v) => seen.push(v));
      const r = await runIn(sbx, 'curl', ['-sS', '-m', '10', '-o', '/dev/null', 'https://example.com']);
      off();
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/403|blocked|CONNECT/i);
      await new Promise((res) => setTimeout(res, 100));
      expect(sbx.violations().some((v) => v.kind === 'net.allow' && v.value === 'example.com')).toBe(true);
    });

    it('blocks the cloud metadata address 169.254.169.254', async () => {
      const r = await runIn(sbx, 'curl', ['-sS', '-m', '5', 'http://169.254.169.254/latest/meta-data/']);
      expect(r.code).not.toBe(0);
      const r2 = await runIn(sbx, 'curl', [
        '-sS',
        '-m',
        '5',
        '--proxy',
        'http://localhost:3128',
        'http://169.254.169.254/latest/meta-data/',
      ]);
      expect(r2.code).not.toBe(0);
    });

    it('scrubs the environment (SECRET_TOKEN removed, explicit vars kept)', async () => {
      const r = await runIn(sbx, 'env', []);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain('SECRET_TOKEN');
      expect(r.stdout).not.toContain('sk-should-not-leak');
      expect(r.stdout).toContain(`HOME=${fx.home}`);
    });

    it('cannot reach a host-loopback service unless it is the broker port', async () => {
      const r = await runIn(sbx, 'curl', ['-sS', '-m', '5', `http://127.0.0.1:${port}/`]);
      expect(r.stdout).not.toContain('hello-from-host');

      const withBroker = await createSandbox(policy, {
        backend: 'srt',
        sourceEnv,
        env: { HOME: fx.home },
        home: fx.home,
        brokerPort: port,
      });
      try {
        const ok = await runIn(withBroker, 'curl', ['-sS', '-m', '10', `http://127.0.0.1:${port}/`]);
        expect(ok.stdout).toBe('hello-from-host');
      } finally {
        await withBroker.close();
      }
    });

    it('host-loopback forwarding: proxy-unaware clients reach allow-listed ports, own loopback servers work, other ports stay closed', async () => {
      const other = createServer((_req, res) => res.end('other-host-service'));
      await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
      const otherPort = (other.address() as AddressInfo).port;
      const s = await createSandbox(policy, {
        backend: 'srt',
        sourceEnv,
        env: { HOME: fx.home },
        home: fx.home,
        brokerPort: port,
        localAllow: [`127.0.0.1:${port}`],
      });
      // Runs inside the sandbox under bare node: global fetch ignores HTTP(S)_PROXY entirely.
      const probe = `
        const http = require('node:http');
        const get = async (u, o) => { try { const r = await fetch(u, o); return r.status + ':' + (await r.text()); } catch (e) { return 'err:' + (e.cause?.code ?? e.message); } };
        (async () => {
          const out = { noProxy: process.env.NO_PROXY };
          out.allowed = await get('http://127.0.0.1:${port}/');
          out.otherDirect = await get('http://127.0.0.1:${otherPort}/');
          const own = http.createServer((q, r) => r.end('own-loopback-server'));
          await new Promise((r) => own.listen(0, '127.0.0.1', r));
          out.own = await get('http://127.0.0.1:' + own.address().port + '/');
          own.close();
          console.log(JSON.stringify(out));
        })();`;
      try {
        const r = await runIn(s, process.execPath, ['-e', probe]);
        const out = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}');
        expect(out.noProxy).toContain('127.0.0.1');
        expect(out.allowed).toBe('200:hello-from-host');
        expect(out.own).toBe('200:own-loopback-server');
        expect(out.otherDirect).toMatch(/^err:/);
        // ...and explicitly through srt's proxy, the non-allow-listed host port is refused too.
        const viaProxy = await runIn(s, 'sh', [
          '-c',
          `curl -sS -m 5 --proxy "$HTTP_PROXY" http://127.0.0.1:${otherPort}/; echo " rc=$?"`,
        ]);
        expect(viaProxy.stdout).not.toContain('other-host-service');
        const viaProxyOk = await runIn(s, 'sh', [
          '-c',
          `curl -sS -m 5 --proxy "$HTTP_PROXY" http://127.0.0.1:${port}/`,
        ]);
        expect(viaProxyOk.stdout).toBe('hello-from-host');
        // The forwarders never keep the sandbox alive after the command exits.
        const t0 = Date.now();
        expect((await runIn(s, 'true', [])).code).toBe(0);
        expect(Date.now() - t0).toBeLessThan(5000);
      } finally {
        await s.close();
        other.close();
      }
    });

    it('strict profile makes rw mounts read-only', async () => {
      const strict = compilePolicy('strict', [{ path: fx.ws, mode: 'rw' }], {}, { home: fx.home });
      const s = await createSandbox(strict, { backend: 'srt', sourceEnv, home: fx.home });
      try {
        const target = join(fx.ws, 'strict.txt');
        const r = await runIn(s, 'sh', ['-c', `echo no > ${target}`]);
        expect(r.code).not.toBe(0);
        expect(existsSync(target)).toBe(false);
      } finally {
        await s.close();
      }
    });

    it('isolateHome hides the rest of HOME but keeps mounts inside it readable', async () => {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const proj = join(fx.home, 'proj');
      const other = join(fx.home, 'other');
      mkdirSync(proj, { recursive: true });
      mkdirSync(other, { recursive: true });
      writeFileSync(join(proj, 'a.txt'), 'proj-file');
      writeFileSync(join(other, 'b.txt'), 'other-file');
      const p = compilePolicy('strict', [{ path: proj, mode: 'ro' }], {}, { home: fx.home });
      const s = await createSandbox(p, { backend: 'srt', sourceEnv, home: fx.home, isolateHome: true });
      try {
        expect((await runIn(s, 'cat', [join(proj, 'a.txt')])).stdout).toBe('proj-file');
        expect((await runIn(s, 'cat', [join(other, 'b.txt')])).stdout).not.toContain('other-file');
        expect((await runIn(s, 'cat', [join(fx.home, '.ssh', 'id_x')])).stdout).not.toContain('FAKE');
      } finally {
        await s.close();
      }
    });

    it('learning mode lets unknown hosts through and reports them', async () => {
      const p = compilePolicy('strict', [], { learning: true }, { home: fx.home });
      const s = await createSandbox(p, { backend: 'srt', sourceEnv, home: fx.home });
      try {
        const got: Violation[] = [];
        s.onViolation((v) => got.push(v));
        // .invalid never resolves, so nothing leaves the machine; the proxy still asks first.
        await runIn(s, 'curl', ['-sS', '-m', '5', 'http://beamhop-learning.invalid/']);
        await new Promise((res) => setTimeout(res, 100));
        expect(
          got.some((v) => v.kind === 'net.allow' && v.value === 'beamhop-learning.invalid' && v.allowed),
        ).toBe(true);
      } finally {
        await s.close();
      }
    });

    it('propagates the exit code of the wrapped command', async () => {
      const r = await runIn(sbx, 'sh', ['-c', 'exit 7']);
      expect(r.code).toBe(7);
    });
  },
);
