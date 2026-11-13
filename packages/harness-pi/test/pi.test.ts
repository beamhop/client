import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HarnessEvent, HarnessSession, SessionSpec } from '@beamhop/core';
import { unsafePassthroughSandbox, writeFakeBin } from '@beamhop/harness-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mapPiEvent, PI_GATE_EXTENSION, piArgs, piHarness } from '../src/index.ts';

let root: string;
let work: string;
let bin: string;
let piBin: string;
const sessions: HarnessSession[] = [];

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'beamhop-pi-'));
  work = path.join(root, 'work');
  bin = path.join(root, 'bin');
  mkdirSync(work);
  mkdirSync(bin);
  writeFileSync(path.join(work, 'img.png'), Buffer.from([137, 80, 78, 71]));
  const fake = pathToFileURL(path.join(import.meta.dirname, 'fake-pi.mjs')).href;
  piBin = writeFakeBin(bin, 'pi', `await import(${JSON.stringify(fake)});`);
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  sessionId: 'b-1',
  agent: 't',
  model: 'openrouter/google/gemini-2.5-flash',
  cwd: work,
  mounts: [{ path: work, mode: 'rw' }],
  permissionMode: 'ask',
  env: { PATH: process.env.PATH ?? '' },
  mcpServers: [],
  ...over,
});
const start = async (over: Partial<SessionSpec> = {}) => {
  const s = await piHarness({ command: piBin }).start(spec(over), unsafePassthroughSandbox());
  sessions.push(s);
  return s;
};
const run = async (
  s: HarnessSession,
  text: string,
  allow?: { allow: boolean; always?: boolean },
  att?: { path: string; mime: string }[],
) => {
  const evs: HarnessEvent[] = [];
  for await (const ev of s.prompt(text, att)) {
    evs.push(ev);
    if (ev.type === 'permission_request' && allow) await s.respondPermission(ev.id, allow);
  }
  return evs;
};
const text = (evs: HarnessEvent[]) => evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');

describe('piArgs', () => {
  it('leaves the model to pi for the "default" model', () => {
    expect(piArgs(spec({ permissionMode: 'auto', model: 'default' }))).toEqual(['--mode', 'rpc']);
  });
  it('builds rpc args per mode', () => {
    expect(piArgs(spec({ permissionMode: 'auto' }))).toEqual([
      '--mode',
      'rpc',
      '--model',
      'openrouter/google/gemini-2.5-flash',
    ]);
    expect(piArgs(spec({ permissionMode: 'read-only', model: '', resume: '/s/x.jsonl' }))).toEqual([
      '--mode',
      'rpc',
      '--session',
      '/s/x.jsonl',
      '--tools',
      'read,grep,find,ls',
    ]);
    expect(piArgs(spec())).toContain(PI_GATE_EXTENSION);
  });
});

describe('pi harness against a fake RPC server', () => {
  it('streams text/thinking, usage and done with a resume token', async () => {
    const s = await start();
    expect(s.id).toBe('pi-sess-1');
    const evs = await run(s, 'hello');
    expect(text(evs)).toBe('pong');
    expect(evs).toContainEqual({ type: 'thinking', delta: 'hmm' });
    expect(evs).toContainEqual({ type: 'usage', inputTokens: 50, outputTokens: 5, costUsd: 0.0001 });
    expect(evs.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn', resume: '/sessions/pi-sess-1.jsonl' });
  });

  it('passes model, session and gate extension args', async () => {
    const s = await start({ resume: '/sessions/old.jsonl' });
    const out = JSON.parse(text(await run(s, 'echo')));
    expect(out.argv).toEqual([
      '--mode',
      'rpc',
      '--model',
      'openrouter/google/gemini-2.5-flash',
      '--session',
      '/sessions/old.jsonl',
      '--extension',
      PI_GATE_EXTENSION,
    ]);
  });

  it('maps gate confirms to permission requests (allow, always, deny)', async () => {
    const s = await start();
    const evs = await run(s, 'tool', { allow: true });
    expect(evs.find((e) => e.type === 'permission_request')).toMatchObject({
      tool: 'edit',
      input: { path: 'a.txt' },
    });
    expect(evs.find((e) => e.type === 'tool_call')).toMatchObject({ id: 'call_1', name: 'edit' });
    expect(evs.find((e) => e.type === 'tool_result')).toMatchObject({
      ok: true,
      output: 'edited',
      diff: expect.stringContaining('+y'),
    });
    expect(text(evs)).toBe('did-it');

    const denied = await run(s, 'tool', { allow: false });
    expect(denied.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false });
    expect(text(denied)).toBe('blocked');

    await run(s, 'tool', { allow: true, always: true });
    const again = await run(s, 'tool');
    expect(again.some((e) => e.type === 'permission_request')).toBe(false);
    expect(text(again)).toBe('did-it');
  });

  it('auto mode runs without the gate', async () => {
    const s = await start({ permissionMode: 'auto' });
    const evs = await run(s, 'tool');
    expect(evs.some((e) => e.type === 'permission_request')).toBe(false);
  });

  it('sends image attachments inside mounts and rejects others', async () => {
    const s = await start();
    const out = JSON.parse(
      text(await run(s, 'echo', undefined, [{ path: path.join(work, 'img.png'), mime: 'image/png' }])),
    );
    expect(out.images).toBe(1);
    const evs = await run(s, 'echo', undefined, [{ path: '/etc/hosts', mime: 'text/plain' }]);
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/outside/) });
  });

  it('reports model errors and rejected prompts', async () => {
    const s = await start();
    const evs = await run(s, 'fail');
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ message: '401 invalid key' });
    expect(evs.at(-1)).toMatchObject({ type: 'done', stopReason: 'error' });
    const rej = await run(s, 'reject');
    expect(rej.find((e) => e.type === 'error')?.type).toBe('error');
  });

  it('cancel aborts the turn', async () => {
    const s = await start();
    const evs: HarnessEvent[] = [];
    for await (const ev of s.prompt('hang')) {
      evs.push(ev);
      if (ev.type === 'text') await s.cancel();
    }
    expect(evs.at(-1)).toMatchObject({ type: 'done', stopReason: 'cancelled' });
  });

  it('handles a crash and refuses further prompts', async () => {
    const s = await start();
    const evs = await run(s, 'crash');
    expect(evs.at(-1)).toMatchObject({ type: 'done', stopReason: 'error' });
    expect(() => s.prompt('x')).toThrow(/not running/);
  });

  it('rejects concurrent prompts', async () => {
    const s = await start();
    const first = s.prompt('hang');
    expect(() => s.prompt('x')).toThrow(/already running/);
    await s.cancel();
    for await (const _ of first) {
      // drain
    }
  });

  it('detects a fake pi binary', async () => {
    const d = await piHarness({ scan: { env: { PATH: bin }, home: root } }).detect();
    expect(d).toMatchObject({ id: 'pi', version: '0.73.1', protocol: 'pi-rpc', status: 'needs-login' });
  });

  it('fails start when pi does not answer', async () => {
    const dead = writeFakeBin(bin, 'deadpi', 'process.exit(1);');
    await expect(piHarness({ command: dead }).start(spec(), unsafePassthroughSandbox())).rejects.toThrow(
      /pi/,
    );
  });
});

describe('mapPiEvent', () => {
  it('ignores unknown events and non-assistant messages', () => {
    const acc = { input: 0, output: 0, cost: 0 };
    expect(mapPiEvent({ type: 'queue_update' }, acc)).toEqual([]);
    expect(mapPiEvent({ type: 'message_end', message: { role: 'toolResult' } }, acc)).toEqual([]);
    expect(
      mapPiEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: '529' }, acc)[0],
    ).toMatchObject({
      type: 'progress',
    });
  });
});
