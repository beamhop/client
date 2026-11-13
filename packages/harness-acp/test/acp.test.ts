import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HarnessEvent, HarnessSession, SessionSpec } from '@beamhop/core';
import { loadCatalog } from '@beamhop/harness-catalog';
import { unsafePassthroughSandbox, writeFakeAcpAgent, writeFakeBin } from '@beamhop/harness-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  acpHarnessesFromCatalog,
  acpHarnessFromCatalog,
  autoDecision,
  chooseOption,
  createAcpHarness,
  customAcpHarness,
  mapSessionUpdate,
  opencodeHarness,
  renderDiff,
} from '../src/index.ts';

let root: string;
let work: string;
let outside: string;
let agentBin: string;
const sessions: HarnessSession[] = [];

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'beamhop-acp-'));
  work = path.join(root, 'work');
  outside = path.join(root, 'outside');
  mkdirSync(work);
  mkdirSync(outside);
  writeFileSync(path.join(work, 'note.txt'), 'line1\nline2\nline3');
  writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  agentBin = writeFakeAcpAgent(path.join(root), 'fake-agent');
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  sessionId: 'beamhop-1',
  agent: 'test',
  model: '',
  cwd: work,
  mounts: [{ path: work, mode: 'rw' }],
  permissionMode: 'ask',
  env: { PATH: process.env.PATH ?? '' },
  mcpServers: [],
  ...over,
});

const plugin = (args: string[] = []) =>
  createAcpHarness({ id: 'fake', displayName: 'Fake', command: agentBin, args, detect: async () => null });

const start = async (over: Partial<SessionSpec> = {}) => {
  const s = await plugin().start(spec(over), unsafePassthroughSandbox());
  sessions.push(s);
  return s;
};

const run = async (
  s: HarnessSession,
  text: string,
  onPerm?: (
    ev: Extract<HarnessEvent, { type: 'permission_request' }>,
  ) => Parameters<HarnessSession['respondPermission']>[1],
) => {
  const evs: HarnessEvent[] = [];
  for await (const ev of s.prompt(text)) {
    evs.push(ev);
    if (ev.type === 'permission_request' && onPerm) await s.respondPermission(ev.id, onPerm(ev));
  }
  return evs;
};
const textOf = (evs: HarnessEvent[]) =>
  evs
    .filter((e): e is Extract<HarnessEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');

describe('ACP harness against a fake agent', () => {
  it('streams text, thinking and done', async () => {
    const s = await start();
    expect(s.id).toBe('sess-1');
    const evs = await run(s, 'say pong');
    expect(textOf(evs)).toBe('pong');
    expect(evs).toContainEqual({ type: 'thinking', delta: 'thinking' });
    expect(evs.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn', resume: 'sess-1' });
    // second turn in the same process
    expect(textOf(await run(s, 'again'))).toBe('pong');
  });

  it('passes cwd and MCP servers to session/new', async () => {
    const s = await start({
      mcpServers: [{ name: 'beamhop', command: 'node', args: ['mcp.js'], env: { A: '1' } }],
    });
    const out = JSON.parse(textOf(await run(s, 'echo-setup')));
    expect(out.cwd).toBe(work);
    expect(out.mcpServers).toEqual([
      { name: 'beamhop', command: 'node', args: ['mcp.js'], env: [{ name: 'A', value: '1' }] },
    ]);
    expect(out.loaded).toBe(false);
  });

  it('resumes via session/load and ignores replayed history', async () => {
    const s = await start({ resume: 'old-session' });
    expect(s.id).toBe('old-session');
    const evs = await run(s, 'echo-setup');
    const out = JSON.parse(textOf(evs));
    expect(out.loaded).toBe(true);
    expect(textOf(evs)).not.toContain('old answer');
  });

  it('routes permission requests and writes inside mounts with diff results', async () => {
    const s = await start();
    const target = path.join(work, 'out.txt');
    const evs = await run(s, `tool write:${target}`, () => ({ allow: true }));
    const perm = evs.find((e) => e.type === 'permission_request');
    expect(perm).toMatchObject({
      tool: 'edit',
      title: `Write ${target}`,
      options: ['Allow', 'Always allow', 'Reject'],
    });
    expect(evs.find((e) => e.type === 'tool_call')).toMatchObject({ id: 'tc-1', name: 'edit' });
    const result = evs.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ id: 'tc-1', ok: true, output: 'wrote 5 bytes' });
    expect((result as { diff: string }).diff).toContain('+hello');
    expect(evs.some((e) => e.type === 'progress' && e.message.includes('write the file'))).toBe(true);
    expect(textOf(evs)).toBe('allowed:allow');
    expect(readFileSync(target, 'utf8')).toBe('hello');
  });

  it('remembers "always" approvals for the session', async () => {
    const s = await start();
    const t1 = path.join(work, 'a1.txt');
    const evs1 = await run(s, `tool write:${t1}`, () => ({ allow: true, always: true }));
    expect(textOf(evs1)).toBe('allowed:always');
    const evs2 = await run(s, `tool write:${path.join(work, 'a2.txt')}`);
    expect(evs2.some((e) => e.type === 'permission_request')).toBe(false);
    expect(textOf(evs2)).toBe('allowed:always');
  });

  it('denies when the owner rejects', async () => {
    const s = await start();
    const target = path.join(work, 'denied.txt');
    const evs = await run(s, `tool write:${target}`, () => ({ allow: false }));
    expect(textOf(evs)).toBe('denied');
    expect(evs.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false });
    expect(existsSync(target)).toBe(false);
  });

  it('auto mode approves without asking; read-only mode denies edits', async () => {
    const auto = await start({ permissionMode: 'auto' });
    const evs = await run(auto, `tool write:${path.join(work, 'auto.txt')}`);
    expect(evs.some((e) => e.type === 'permission_request')).toBe(false);
    expect(textOf(evs)).toBe('allowed:allow');
    const ro = await start({ permissionMode: 'read-only' });
    const evs2 = await run(ro, `tool write:${path.join(work, 'ro.txt')}`);
    expect(textOf(evs2)).toBe('denied');
  });

  it('blocks fs writes outside rw mounts and to ro mounts', async () => {
    const s = await start({
      mounts: [
        { path: work, mode: 'ro' },
        { path: outside, mode: 'ro' },
      ],
    });
    const evs = await run(s, `tool write:${path.join(outside, 'x.txt')}`, () => ({ allow: true }));
    expect(textOf(evs)).toBe('write-failed');
    expect(existsSync(path.join(outside, 'x.txt'))).toBe(false);
  });

  it('serves fs reads only inside mounts (incl. symlink escapes)', async () => {
    const s = await start();
    expect(textOf(await run(s, `read:${path.join(work, 'note.txt')}`))).toBe('content=line1\nline2\nline3');
    expect(textOf(await run(s, 'read:note.txt'))).toBe('content=line1\nline2\nline3');
    expect(textOf(await run(s, `read:${path.join(outside, 'secret.txt')}`))).toMatch(/^read-error=.*outside/);
    expect(textOf(await run(s, `read:${path.join(work, '..', 'outside', 'secret.txt')}`))).toMatch(
      /read-error/,
    );
    if (process.platform !== 'win32') {
      const { symlinkSync } = await import('node:fs');
      symlinkSync(path.join(outside, 'secret.txt'), path.join(work, 'link.txt'));
      expect(textOf(await run(s, `read:${path.join(work, 'link.txt')}`))).toMatch(/read-error/);
    }
  });

  it('cancel sends session/cancel and ends the turn', async () => {
    const s = await start();
    const evs: HarnessEvent[] = [];
    for await (const ev of s.prompt('hang')) {
      evs.push(ev);
      if (ev.type === 'text') await s.cancel();
    }
    expect(evs.at(-1)).toMatchObject({ type: 'done', stopReason: 'cancelled' });
  });

  it('rejects concurrent prompts', async () => {
    const s = await start();
    const it1 = s.prompt('hang');
    expect(() => s.prompt('again')).toThrow(/already running/);
    await s.cancel();
    for await (const _ of it1) {
      // drain
    }
  });

  it('reports an agent crash mid-turn', async () => {
    const s = await start();
    const evs = await run(s, 'crash');
    expect(evs.find((e) => e.type === 'error')).toBeDefined();
    expect(evs.at(-1)).toMatchObject({ type: 'done', stopReason: 'error' });
    expect(() => s.prompt('x')).toThrow(/not running/);
  });

  it('fails start when the command is not an ACP agent', async () => {
    const bad = writeFakeBin(root, 'not-acp', `console.error('nope'); process.exit(1);`);
    const p = createAcpHarness({ id: 'bad', displayName: 'Bad', command: bad, detect: async () => null });
    await expect(p.start(spec(), unsafePassthroughSandbox())).rejects.toThrow(
      /exited during startup|failed to start/,
    );
  });

  it('spawns through SandboxHandle.wrap', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const sb = unsafePassthroughSandbox({ SANDBOXED: '1' });
    const wrapping = {
      ...sb,
      wrap: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return sb.wrap(cmd, args);
      },
    };
    const s = await createAcpHarness({
      id: 'x',
      displayName: 'X',
      command: agentBin,
      args: ['--acp'],
      detect: async () => null,
    }).start(spec(), wrapping);
    sessions.push(s);
    expect(calls).toEqual([{ cmd: agentBin, args: ['--acp'] }]);
  });

  it('custom ACP harness detects via handshake', async () => {
    const det = await customAcpHarness({
      id: 'mine',
      command: agentBin,
      probeEnv: { PATH: process.env.PATH ?? '' },
    }).detect();
    expect(det).toMatchObject({
      status: 'ready',
      displayName: 'Fake ACP',
      version: '1.2.3',
      protocol: 'acp',
    });
  });
});

describe('catalog plugins', () => {
  it('builds plugins for ACP entries', () => {
    const ids = acpHarnessesFromCatalog().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['gemini', 'copilot', 'opencode', 'goose', 'qwen-code']));
    expect(ids).not.toContain('claude');
    expect(opencodeHarness().displayName).toBe('OpenCode');
    expect(() =>
      acpHarnessFromCatalog(loadCatalog().harnesses.find((h) => h.id === 'claude')!),
    ).not.toThrow();
  });

  it('detects and launches opencode from a fake binary', async () => {
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFakeAcpAgent(bin, 'opencode');
    const p = opencodeHarness({ scan: { env: { PATH: bin, OPENROUTER_API_KEY: 'x' }, home: root } });
    const det = await p.detect();
    expect(det).toMatchObject({ id: 'opencode', status: 'ready', version: '1.2.3' });
    const s = await p.start(spec(), unsafePassthroughSandbox());
    sessions.push(s);
    expect(textOf(await run(s, 'hi'))).toBe('pong');
  });
});

describe('mapping helpers', () => {
  it('maps tool calls that complete immediately', () => {
    const evs = mapSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't',
      title: 'Read',
      kind: 'read',
      status: 'completed',
      rawOutput: { bytes: 3 },
    });
    expect(evs).toEqual([
      { type: 'tool_call', id: 't', name: 'read', input: null, title: 'Read' },
      { type: 'tool_result', id: 't', ok: true, output: '{"bytes":3}', diff: undefined },
    ]);
    expect(
      mapSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'in_progress' }),
    ).toEqual([]);
    expect(mapSessionUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'x' })).toEqual([]);
  });

  it('renders diffs', () => {
    expect(renderDiff('a.txt', 'x', 'y')).toBe('--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y');
    expect(renderDiff('n.txt', null, 'y')).toContain('--- /dev/null');
  });

  it('chooses options and auto decisions', () => {
    const opts = [
      { optionId: 'a', name: 'A', kind: 'allow_once' as const },
      { optionId: 'r', name: 'R', kind: 'reject_once' as const },
    ];
    expect(chooseOption(opts, { allow: true, always: true })?.optionId).toBe('a');
    expect(chooseOption(opts, { allow: false })?.optionId).toBe('r');
    expect(chooseOption([], { allow: true })).toBeUndefined();
    expect(autoDecision('ask', 'edit')).toBeUndefined();
    expect(autoDecision('plan', 'read')).toEqual({ allow: true });
    expect(autoDecision('plan', 'execute')?.allow).toBe(false);
    expect(autoDecision('auto', 'execute')).toEqual({ allow: true });
  });
});
