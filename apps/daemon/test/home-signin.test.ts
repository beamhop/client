import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { HarnessJob } from '@beamhop/core';
import { findHarness, loadCatalog } from '@beamhop/harness-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homeSignInBody, type InstallerDeps, OPEN_SHIM } from '../src/harness-install.ts';
import { HarnessJobs, type SpawnFn } from '../src/harness-jobs.ts';
import { homeEnv, readHome, writeHome } from '../src/home-login.ts';
import { until } from './helpers.ts';

class Child extends EventEmitter {
  pid = undefined;
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: string[] = [];
  stdin = {
    write: (s: string) => {
      this.written.push(s);
      this.emit('stdin', s);
      return true;
    },
  };
  constructor(
    readonly cmd: string,
    readonly args: string[],
    readonly env: NodeJS.ProcessEnv,
  ) {
    super();
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.stdout.end();
    this.stderr.end();
    setTimeout(() => this.emit('exit', code, signal), 5);
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.exit(null, signal);
    return true;
  }
}

const deps = (opened: string[], platform: NodeJS.Platform = 'darwin'): InstallerDeps => ({
  platform,
  arch: 'arm64',
  env: { PATH: '/usr/bin' },
  home: '/home/u',
  beamhopHome: '/home/u/.beamhop',
  which: (c) => (c === 'script' ? '/usr/bin/script' : undefined),
  fetch: (() => Promise.reject(new Error('no network'))) as never,
  openUrl: (u) => opened.push(u),
  capture: async () => ({ code: 1, stdout: '' }),
});

const done = (j: HarnessJob) => ['done', 'failed', 'cancelled'].includes(j.step);

describe('subscription sign-in', () => {
  const cat = loadCatalog();
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bh-signin-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('codex: runs `login` with CODEX_HOME in a fresh dir, opens the page, stores auth.json', async () => {
    const entry = findHarness(cat, 'codex')!;
    const m = entry.auth.methods.find((x) => x.id === 'chatgpt')!;
    writeHome(dir, m.home!);
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toContain('cli_auth_credentials_store = "file"');
    let child!: Child;
    const spawn: SpawnFn = (cmd, args, o) => {
      child = new Child(cmd, args, o.env);
      setTimeout(() => {
        child.stdout.write('Open https://auth.openai.com/oauth/authorize?x=1 to sign in\n');
        setTimeout(() => writeFileSync(join(dir, 'auth.json'), '{"tokens":{"refresh_token":"r"}}'), 20);
      }, 5);
      return child;
    };
    const stored: Record<string, string>[] = [];
    const opened: string[] = [];
    const jobs = new HarnessJobs({ spawn });
    const job = jobs.start(
      { harness: 'codex', kind: 'login' },
      homeSignInBody(
        entry,
        m,
        deps(opened),
        {
          binary: '/bin/codex',
          dir,
          read: () => readHome(dir, m.home!),
          store: async (f) => void stored.push(f),
        },
        homeEnv(dir, m.home!),
        true,
      ),
    );
    await until(() => done(jobs.get(job.id).job), 5000, 'sign-in');
    expect(jobs.get(job.id).job.step).toBe('done');
    expect(child.cmd).toBe('/usr/bin/script');
    expect(child.args).toContain('/bin/codex');
    expect(child.args).toContain('login');
    expect(child.env.CODEX_HOME).toBe(dir);
    expect(opened).toEqual(['https://auth.openai.com/oauth/authorize?x=1']);
    expect(stored).toEqual([{ 'auth.json': '{"tokens":{"refresh_token":"r"}}' }]);
  });

  it('codex headless: device-code args, prints the code, never opens a browser', async () => {
    const entry = findHarness(cat, 'codex')!;
    const m = entry.auth.methods.find((x) => x.id === 'chatgpt')!;
    let child!: Child;
    const spawn: SpawnFn = (cmd, args, o) => {
      child = new Child(cmd, args, o.env);
      setTimeout(() => {
        child.stdout.write('Go to https://auth.openai.com/codex/device and enter code ABCD-1234\n');
        writeFileSync(join(dir, 'auth.json'), '{"t":1}');
      }, 5);
      return child;
    };
    const opened: string[] = [];
    const jobs = new HarnessJobs({ spawn });
    const job = jobs.start(
      { harness: 'codex', kind: 'login' },
      homeSignInBody(
        entry,
        m,
        deps(opened),
        { binary: '/bin/codex', dir, read: () => readHome(dir, m.home!), store: async () => {} },
        homeEnv(dir, m.home!),
        false,
      ),
    );
    await until(() => done(jobs.get(job.id).job), 5000, 'sign-in');
    expect(child.args).toContain('--device-auth');
    expect(jobs.get(job.id).job).toMatchObject({ step: 'done', code: 'ABCD-1234' });
    expect(opened).toEqual([]);
  });

  it('gemini: signs in over ACP (initialize, authenticate) and captures the page the CLI tries to open', async () => {
    const entry = findHarness(cat, 'gemini')!;
    const m = entry.auth.methods.find((x) => x.id === 'google-account')!;
    writeHome(dir, m.home!);
    let child!: Child;
    const spawn: SpawnFn = (cmd, args, o) => {
      child = new Child(cmd, args, o.env);
      child.on('stdin', (s: string) => {
        const req = JSON.parse(s) as { id: number; method: string };
        if (req.method === 'initialize')
          child.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1 } })}\n`,
          );
        if (req.method === 'authenticate') {
          // What the `open` stand-in prints, then the CLI saves the creds and answers.
          child.stderr.write('Open this page: https://accounts.google.com/o/oauth2/v2/auth?client=x\n');
          setTimeout(() => {
            mkdirSync(join(dir, '.gemini'), { recursive: true });
            writeFileSync(join(dir, '.gemini/oauth_creds.json'), '{"refresh_token":"g"}');
            child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} })}\n`);
          }, 20);
        }
      });
      return child;
    };
    const opened: string[] = [];
    const stored: Record<string, string>[] = [];
    const jobs = new HarnessJobs({ spawn });
    const job = jobs.start(
      { harness: 'gemini', kind: 'login' },
      homeSignInBody(
        entry,
        m,
        deps(opened),
        {
          binary: '/bin/gemini',
          dir,
          read: () => readHome(dir, m.home!),
          store: async (f) => void stored.push(f),
        },
        homeEnv(dir, m.home!),
        true,
      ),
    );
    await until(() => done(jobs.get(job.id).job), 5000, 'sign-in');
    expect(jobs.get(job.id).job.step).toBe('done');
    expect(child.cmd).toBe('/bin/gemini'); // no pseudo-terminal for JSON-RPC
    expect(child.args).toEqual(['--acp']);
    expect(child.written.map((w) => JSON.parse(w).method)).toEqual(['initialize', 'authenticate']);
    expect(child.env.GEMINI_CLI_HOME).toBe(dir);
    expect(child.env.PATH?.split(':')[0]).toBe(join(dir, '.beamhop-open'));
    expect(readFileSync(join(dir, '.beamhop-open', 'open'), 'utf8')).toBe(OPEN_SHIM);
    expect(opened).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?client=x']);
    expect(stored).toEqual([{ '.gemini/oauth_creds.json': '{"refresh_token":"g"}' }]);
  });

  it('fails plainly when the sign-in ends without a login', async () => {
    const entry = findHarness(cat, 'kimi-code')!;
    const m = entry.auth.methods[0]!;
    const spawn: SpawnFn = (cmd, args, o) => {
      const c = new Child(cmd, args, o.env);
      setTimeout(() => c.exit(1), 5);
      return c;
    };
    const jobs = new HarnessJobs({ spawn });
    const job = jobs.start(
      { harness: 'kimi-code', kind: 'login' },
      homeSignInBody(
        entry,
        m,
        deps([]),
        { binary: '/bin/kimi', dir, read: () => readHome(dir, m.home!), store: async () => {} },
        homeEnv(dir, m.home!),
        true,
      ),
    );
    await until(() => done(jobs.get(job.id).job), 5000, 'sign-in');
    expect(jobs.get(job.id).job).toMatchObject({
      step: 'failed',
      message: expect.stringMatching(/didn't finish/),
    });
  });

  it('auggie and cursor: {home} in args and env, the login as an env var for sessions', () => {
    const aug = findHarness(cat, 'auggie')!.auth.methods[0]!;
    expect(aug.signIn!.args).toContain('{home}');
    expect(homeEnv(dir, aug.home!, { v: 1, files: { 'session.json': '{"accessToken":"a"}\n' } })).toEqual({
      AUGMENT_SESSION_AUTH: '{"accessToken":"a"}',
    });
    const cur = findHarness(cat, 'cursor-agent')!.auth.methods[0]!;
    expect(homeEnv(dir, cur.home!)).toMatchObject({ HOME: dir, AGENT_CLI_CREDENTIAL_STORE: 'file' });
    mkdirSync(join(dir, 'cursor'), { recursive: true });
    writeFileSync(join(dir, 'cursor/auth.json'), '{"a":1}');
    expect(readHome(dir, cur.home!)).toEqual({ 'cursor/auth.json': '{"a":1}' });
  });
});
