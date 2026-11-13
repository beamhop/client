import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HarnessEvent, HarnessSession, SessionSpec } from '@beamhop/core';
import { unsafePassthroughSandbox, writeFakeBin } from '@beamhop/harness-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { codexHarness, codexPolicy, execArgs, mapExecEvent, mcpConfigArgs } from '../src/index.ts';

let root: string;
let work: string;
let bin: string;
let codexBin: string;
const sessions: HarnessSession[] = [];

beforeAll(() => {
  // Real path: attachments are resolved (macOS tmpdir is /var -> /private/var).
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'beamhop-codex-')));
  work = path.join(root, 'work');
  bin = path.join(root, 'bin');
  mkdirSync(work);
  mkdirSync(bin);
  writeFileSync(path.join(work, 'shot.png'), 'png');
  const fake = pathToFileURL(path.join(import.meta.dirname, 'fake-codex.mjs')).href;
  codexBin = writeFakeBin(bin, 'codex', `await import(${JSON.stringify(fake)});`);
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  sessionId: 'b-1',
  agent: 't',
  model: 'gpt-5-codex',
  cwd: work,
  mounts: [{ path: work, mode: 'rw' }],
  permissionMode: 'ask',
  env: { PATH: process.env.PATH ?? '' },
  mcpServers: [{ name: 'beamhop', command: 'node', args: ['mcp.js', 'a "q"'], env: { TOKEN_REF: 'x' } }],
  ...over,
});
const start = async (
  over: Partial<SessionSpec> = {},
  mode: 'app-server' | 'exec' | 'auto' = 'app-server',
  cmd = codexBin,
) => {
  const s = await codexHarness({ command: cmd, mode }).start(spec(over), unsafePassthroughSandbox());
  sessions.push(s);
  return s;
};
const run = async (
  s: HarnessSession,
  text: string,
  d?: { allow: boolean; always?: boolean },
  att?: { path: string; mime: string }[],
) => {
  const evs: HarnessEvent[] = [];
  for await (const ev of s.prompt(text, att)) {
    evs.push(ev);
    if (ev.type === 'permission_request' && d) await s.respondPermission(ev.id, d);
  }
  return evs;
};
const text = (evs: HarnessEvent[]) => evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');

describe('codex app-server', () => {
  it('streams a turn with thinking, plan, usage and done', async () => {
    const s = await start();
    expect(s.id).toBe('thr-1');
    const evs = await run(s, 'hi');
    expect(text(evs)).toBe('pong');
    expect(evs).toContainEqual({ type: 'thinking', delta: 'thinking' });
    expect(evs.some((e) => e.type === 'progress' && e.message.includes('[x] answer'))).toBe(true);
    expect(evs).toContainEqual({ type: 'usage', inputTokens: 100, outputTokens: 7 });
    expect(evs.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn', resume: 'thr-1' });
    // usage is per turn (delta of thread totals)
    expect((await run(s, 'hi')).find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      inputTokens: 100,
      outputTokens: 7,
    });
  });

  it('sends thread params, MCP config overrides and attachments', async () => {
    const s = await start();
    const out = JSON.parse(
      text(await run(s, 'echo', undefined, [{ path: path.join(work, 'shot.png'), mime: 'image/png' }])),
    );
    expect(out.thread.params).toMatchObject({
      cwd: work,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      model: 'gpt-5-codex',
    });
    expect(out.argv).toEqual(['app-server', ...mcpConfigArgs(spec().mcpServers)]);
    expect(out.input[1]).toEqual({ type: 'localImage', path: path.join(work, 'shot.png') });
  });

  it('resumes a thread', async () => {
    const s = await start({ resume: 'thr-old' });
    expect(s.id).toBe('thr-old');
    expect(JSON.parse(text(await run(s, 'echo'))).thread.resumed).toBe(true);
  });

  it('routes command approvals (accept, session, decline)', async () => {
    const s = await start();
    const evs = await run(s, 'cmd', { allow: true });
    expect(evs.find((e) => e.type === 'permission_request')).toMatchObject({
      tool: 'shell',
      title: 'rm -rf build',
    });
    expect(evs.find((e) => e.type === 'tool_call')).toMatchObject({ id: 'cmd1', name: 'shell' });
    expect(evs.find((e) => e.type === 'tool_result')).toMatchObject({
      id: 'cmd1',
      ok: true,
      output: 'removed',
    });
    expect(text(evs)).toBe('decision:accept');
    expect(text(await run(s, 'cmd', { allow: false }))).toBe('decision:decline');
    expect(text(await run(s, 'cmd', { allow: true, always: true }))).toBe('decision:acceptForSession');
    const auto = await run(s, 'cmd');
    expect(auto.some((e) => e.type === 'permission_request')).toBe(false);
    expect(text(auto)).toBe('decision:acceptForSession');
  });

  it('routes file-change approvals and surfaces diffs', async () => {
    const s = await start();
    const evs = await run(s, 'patch', { allow: true });
    expect(evs.find((e) => e.type === 'tool_call')).toMatchObject({
      name: 'apply_patch',
      title: 'Edit a.txt',
    });
    expect(evs.find((e) => e.type === 'tool_result')).toMatchObject({
      ok: true,
      diff: expect.stringContaining('+y'),
    });
    const denied = await run(s, 'patch', { allow: false });
    expect(denied.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false });
  });

  it('reports failed turns', async () => {
    const s = await start();
    const evs = await run(s, 'fail');
    expect(evs).toContainEqual({ type: 'progress', message: 'retrying: rate limited' });
    expect(evs).toContainEqual({ type: 'error', message: 'usage limit reached' });
    expect(evs.at(-1)).toMatchObject({ stopReason: 'error' });
  });

  it('interrupts on cancel', async () => {
    const s = await start();
    const evs: HarnessEvent[] = [];
    for await (const ev of s.prompt('hang')) {
      evs.push(ev);
      if (ev.type === 'text') await s.cancel();
    }
    expect(evs.at(-1)).toMatchObject({ type: 'done', stopReason: 'cancelled' });
  });

  it('handles a crash', async () => {
    const s = await start();
    const evs = await run(s, 'crash');
    expect(evs.find((e) => e.type === 'error')?.type).toBe('error');
    expect(() => s.prompt('x')).toThrow(/not running/);
  });

  it('falls back to exec in auto mode when app-server fails', async () => {
    const broken = writeFakeBin(
      bin,
      'codex-noapp',
      `if (process.argv.includes('app-server')) process.exit(2); else await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'fake-codex.mjs')).href)});`,
    );
    await expect(start({}, 'app-server', broken)).rejects.toThrow(/codex/);
    const s = await start({}, 'auto', broken);
    expect(text(await run(s, 'hi'))).toBe('pong');
  });

  it('detects the fake binary', async () => {
    const d = await codexHarness({ scan: { env: { PATH: bin }, home: root } }).detect();
    expect(d).toMatchObject({
      id: 'codex',
      version: '0.167.2',
      protocol: 'codex-app-server',
      status: 'needs-login',
    });
  });
});

describe('codex exec fallback', () => {
  it('runs a turn and resumes by thread id', async () => {
    const s = await start({}, 'exec');
    const evs = await run(s, 'hi');
    expect(text(evs)).toBe('pong');
    expect(evs.find((e) => e.type === 'tool_result')).toMatchObject({ id: 'c1', ok: true, output: 'a\nb' });
    expect(evs).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 2 });
    expect(evs.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn', resume: 'thr-exec-1' });
    const argv = JSON.parse(text(await run(s, 'echo')));
    expect(argv.slice(argv.indexOf('resume'), argv.indexOf('resume') + 2)).toEqual(['resume', 'thr-exec-1']);
  });

  it('reports failure and supports cancel', async () => {
    const s = await start({}, 'exec');
    const evs = await run(s, 'fail');
    expect(evs).toContainEqual({ type: 'error', message: 'quota exceeded' });
    expect(evs.at(-1)).toMatchObject({ stopReason: 'error' });
    const h: HarnessEvent[] = [];
    const it = s.prompt('hang');
    setTimeout(() => void s.cancel(), 300);
    for await (const ev of it) h.push(ev);
    expect(h.at(-1)).toMatchObject({ stopReason: 'cancelled' });
  });
});

describe('helpers', () => {
  it('maps permission modes', () => {
    expect(codexPolicy('auto')).toEqual({ approvalPolicy: 'never', sandbox: 'workspace-write' });
    expect(codexPolicy('read-only').sandbox).toBe('read-only');
    expect(codexPolicy('ask').approvalPolicy).toBe('untrusted');
  });
  it('quotes MCP config as TOML', () => {
    expect(mcpConfigArgs([{ name: 'my srv', command: 'C:\\n\\x', args: ['a"b'], env: { K: 'v' } }])).toEqual([
      '-c',
      'mcp_servers."my srv".command="C:\\\\n\\\\x"',
      '-c',
      'mcp_servers."my srv".args=["a\\"b"]',
      '-c',
      'mcp_servers."my srv".env={ K = "v" }',
    ]);
  });
  it('builds exec args with prompt after --', () => {
    const a = execArgs(spec({ mcpServers: [], permissionMode: 'read-only' }), '--danger', 'thr', ['/i.png']);
    expect(a.slice(-4)).toEqual(['resume', 'thr', '--', '--danger']);
    expect(a).toContain('--image=/i.png');
    expect(a[a.indexOf('--sandbox') + 1]).toBe('read-only');
  });
  it('maps exec events', () => {
    expect(
      mapExecEvent({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'hm' } }),
    ).toEqual([{ type: 'thinking', delta: 'hm' }]);
    expect(mapExecEvent({ type: 'error', message: 'x' })).toEqual([{ type: 'error', message: 'x' }]);
    expect(mapExecEvent({ type: 'thread.started' })).toEqual([]);
  });
});
