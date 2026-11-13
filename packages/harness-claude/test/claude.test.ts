import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { HarnessEvent, HarnessSession, SessionSpec } from '@beamhop/core';
import { unsafePassthroughSandbox, writeFakeBin } from '@beamhop/harness-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  claudeHarness,
  claudePermissionMode,
  mapSdkMessage,
  type QueryFn,
  sandboxedClaudeSpawner,
  structuredPatchToDiff,
} from '../src/index.ts';

let root: string;
let work: string;
const sessions: HarnessSession[] = [];
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'beamhop-claude-'));
  work = path.join(root, 'work');
  mkdirSync(work);
  writeFileSync(path.join(work, 'pic.png'), 'png');
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const base = {
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: 'cl-sess-1',
  parent_tool_use_id: null,
};
const textOf = (u: SDKUserMessage) => {
  const c = u.message.content;
  return typeof c === 'string'
    ? c
    : (c as { type: string; text?: string }[]).map((b) => b.text ?? `[${b.type}]`).join(' ');
};

/** Fake Query: reacts to prompts like the CLI would, calling canUseTool for tool use. */
const fakeQuery = (record: { options?: Options; prompts: string[] }): QueryFn => {
  return ({ prompt, options }) => {
    record.options = options;
    let interrupted: (() => void) | undefined;
    let interruptPending = false;
    let closed = false;
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      yield { type: 'system', subtype: 'init', ...base } as unknown as SDKMessage;
      for await (const u of prompt) {
        if (closed) return;
        const text = textOf(u);
        record.prompts.push(text);
        const result = (extra: Record<string, unknown> = {}) =>
          ({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'ok',
            total_cost_usd: 0.01,
            usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5 },
            ...base,
            ...extra,
          }) as unknown as SDKMessage;
        if (text.includes('crash')) throw new Error('Claude Code process exited with code 1');
        if (text.includes('hang')) {
          yield {
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'wait' } },
            ...base,
          } as unknown as SDKMessage;
          if (!interruptPending) {
            await new Promise<void>((r) => {
              interrupted = r;
            });
          }
          interruptPending = false;
          yield result({ subtype: 'error_during_execution', is_error: true });
          continue;
        }
        if (text.includes('edit')) {
          yield {
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'a.ts' } }],
            },
            ...base,
          } as unknown as SDKMessage;
          const ac = new AbortController();
          const r = (await options!.canUseTool!('Edit', { file_path: 'a.ts' }, {
            signal: ac.signal,
            title: 'Claude wants to edit a.ts',
            toolUseID: 'tu1',
            suggestions: [
              { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' },
            ],
          } as never)) as PermissionResult;
          yield {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu1',
                  content: r.behavior === 'allow' ? 'edited' : r.message,
                  is_error: r.behavior !== 'allow',
                },
              ],
            },
            tool_use_result:
              r.behavior === 'allow'
                ? {
                    filePath: 'a.ts',
                    structuredPatch: [
                      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] },
                    ],
                  }
                : undefined,
            ...base,
          } as unknown as SDKMessage;
          yield {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'text',
                  text:
                    r.behavior === 'allow' ? `ok:${'updatedPermissions' in r ? 'always' : 'once'}` : 'denied',
                },
              ],
            },
            ...base,
          } as unknown as SDKMessage;
          yield result();
          continue;
        }
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
          ...base,
        } as unknown as SDKMessage;
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'po' } },
          ...base,
        } as unknown as SDKMessage;
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ng' } },
          ...base,
        } as unknown as SDKMessage;
        // full assistant message repeats streamed text: must not be emitted twice
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'pong' }] },
          ...base,
        } as unknown as SDKMessage;
        yield result();
      }
    }
    const g = gen() as Query;
    g.interrupt = async () => {
      if (interrupted) interrupted();
      else interruptPending = true;
      interrupted = undefined;
      return undefined;
    };
    g.close = () => {
      closed = true;
    };
    return g;
  };
};

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  sessionId: 'b-1',
  agent: 't',
  model: 'claude-sonnet-4-5',
  cwd: work,
  mounts: [
    { path: work, mode: 'rw' },
    { path: root, mode: 'ro' },
  ],
  permissionMode: 'ask',
  env: { PATH: '/usr/bin' },
  mcpServers: [{ name: 'beamhop', command: 'node', args: ['mcp.js'], env: { A: '1' } }],
  ...over,
});
const start = async (over: Partial<SessionSpec> = {}) => {
  const rec: { options?: Options; prompts: string[] } = { prompts: [] };
  const s = await claudeHarness({ queryFn: fakeQuery(rec) }).start(spec(over), unsafePassthroughSandbox());
  sessions.push(s);
  return { s, rec };
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

describe('claude harness (fake SDK stream)', () => {
  it('passes SDK options derived from the SessionSpec', async () => {
    const { rec } = await start({ resume: 'old-sess' });
    const o = rec.options!;
    expect(o).toMatchObject({
      cwd: work,
      model: 'claude-sonnet-4-5',
      resume: 'old-sess',
      permissionMode: 'default',
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      additionalDirectories: [root],
      env: { PATH: '/usr/bin' },
      mcpServers: { beamhop: { type: 'stdio', command: 'node', args: ['mcp.js'], env: { A: '1' } } },
    });
    expect(typeof o.spawnClaudeCodeProcess).toBe('function');
    expect(typeof o.canUseTool).toBe('function');
  });

  it('streams text without duplicates, then usage and done with resume id', async () => {
    const { s } = await start();
    const evs = await run(s, 'hi');
    expect(text(evs)).toBe('pong');
    expect(evs).toContainEqual({ type: 'thinking', delta: 'hmm' });
    expect(evs).toContainEqual({ type: 'usage', inputTokens: 15, outputTokens: 3, costUsd: 0.01 });
    expect(evs.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn', resume: 'cl-sess-1' });
    expect(s.id).toBe('cl-sess-1');
    expect(text(await run(s, 'again'))).toBe('pong');
  });

  it('routes canUseTool to permission_request (allow, always, deny)', async () => {
    const { s } = await start();
    const evs = await run(s, 'edit', { allow: true });
    expect(evs.find((e) => e.type === 'permission_request')).toMatchObject({
      tool: 'Edit',
      title: 'Claude wants to edit a.ts',
    });
    expect(evs.find((e) => e.type === 'tool_call')).toMatchObject({ id: 'tu1', name: 'Edit' });
    expect(evs.find((e) => e.type === 'tool_result')).toMatchObject({
      id: 'tu1',
      ok: true,
      output: 'edited',
      diff: expect.stringContaining('+y'),
    });
    expect(text(evs)).toBe('ok:once');
    expect(text(await run(s, 'edit', { allow: false }))).toBe('denied');
    expect(text(await run(s, 'edit', { allow: true, always: true }))).toBe('ok:always');
    const again = await run(s, 'edit');
    expect(again.some((e) => e.type === 'permission_request')).toBe(false);
  });

  it('read-only mode denies write tools without asking', async () => {
    const { s } = await start({ permissionMode: 'read-only' });
    const evs = await run(s, 'edit');
    expect(evs.some((e) => e.type === 'permission_request')).toBe(false);
    expect(text(evs)).toBe('denied');
  });

  it('maps auto and plan modes', async () => {
    const { rec } = await start({ permissionMode: 'auto' });
    expect(rec.options).toMatchObject({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    expect(claudePermissionMode('plan')).toBe('plan');
  });

  it('sends image attachments and rejects paths outside mounts', async () => {
    const { s, rec } = await start();
    await run(s, 'hi', undefined, [{ path: path.join(work, 'pic.png'), mime: 'image/png' }]);
    expect(rec.prompts.at(-1)).toBe('hi [image]');
    const evs = await run(s, 'hi', undefined, [{ path: '/etc/passwd', mime: 'text/plain' }]);
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/outside/) });
  });

  it('cancel interrupts the turn', async () => {
    const { s } = await start();
    const evs: HarnessEvent[] = [];
    for await (const ev of s.prompt('hang')) {
      evs.push(ev);
      if (ev.type === 'text') await s.cancel();
    }
    expect(evs.at(-1)).toMatchObject({ type: 'done', stopReason: 'error_during_execution' });
  });

  it('surfaces a crashed query and refuses later prompts', async () => {
    const { s } = await start();
    const evs = await run(s, 'crash');
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/exited/) });
    expect(evs.at(-1)).toMatchObject({ stopReason: 'error' });
    expect(() => s.prompt('x')).toThrow(/not running/);
  });

  it('rejects concurrent prompts', async () => {
    const { s } = await start();
    const it1 = s.prompt('hang');
    expect(() => s.prompt('x')).toThrow(/already running/);
    await s.cancel();
    for await (const _ of it1) {
      // drain
    }
  });

  it('detects a fake claude binary', async () => {
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFakeBin(bin, 'claude', `console.log('2.1.323 (Claude Code)');`);
    const d = await claudeHarness({
      scan: { env: { PATH: bin, ANTHROPIC_API_KEY: 'set' }, home: root },
    }).detect();
    expect(d).toMatchObject({ id: 'claude', version: '2.1.323', status: 'ready', protocol: 'claude-sdk' });
  });
});

describe('sandboxedClaudeSpawner', () => {
  it('wraps through the sandbox and pipes stdio', async () => {
    const calls: string[][] = [];
    const sb = unsafePassthroughSandbox({ FROM_SANDBOX: '1' });
    const spawner = sandboxedClaudeSpawner({
      ...sb,
      wrap: async (c, a) => {
        calls.push([c, ...a]);
        return sb.wrap(c, a);
      },
    });
    const ac = new AbortController();
    const p = spawner({
      command: process.execPath,
      args: [
        '-e',
        'process.stdin.on("data", d => process.stdout.write(String(d).toUpperCase() + process.env.FROM_SANDBOX)); process.stdin.on("end", () => process.exit(7));',
      ],
      env: { PATH: process.env.PATH, SKIP: undefined },
      signal: ac.signal,
    });
    p.stdin.write('hello');
    const out = await new Promise<string>((resolve) => p.stdout.once('data', (d) => resolve(String(d))));
    expect(out).toBe('HELLO1');
    const code = await new Promise<number | null>((resolve) => {
      p.once('exit', (c) => resolve(c));
      p.stdin.end();
    });
    expect(code).toBe(7);
    expect(p.exitCode).toBe(7);
    expect(calls[0]![0]).toBe(process.execPath);
  });

  it('reports wrap failures as exit', async () => {
    const sb = unsafePassthroughSandbox();
    const p = sandboxedClaudeSpawner({ ...sb, wrap: async () => Promise.reject(new Error('no bwrap')) })({
      command: 'x',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const err = await new Promise<Error>((resolve) => p.on('error', resolve));
    expect(err.message).toBe('no bwrap');
  });

  it('kill before spawn prevents the process', async () => {
    const sb = unsafePassthroughSandbox();
    const p = sandboxedClaudeSpawner(sb)({
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>{},5000)'],
      env: {},
      signal: new AbortController().signal,
    });
    p.kill('SIGTERM');
    const sig = await new Promise((resolve) => p.once('exit', (_c, s) => resolve(s)));
    expect(sig).toBe('SIGTERM');
    expect(p.killed).toBe(true);
  });
});

describe('helpers', () => {
  it('renders structured patches', () => {
    expect(
      structuredPatchToDiff('a', [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] },
      ]),
    ).toBe('--- a/a\n+++ b/a\n@@ -1,1 +1,2 @@\n-a\n+b\n+c');
    expect(structuredPatchToDiff('a', [])).toBeUndefined();
  });
  it('ignores subagent frames and reports error results', () => {
    const st = { streamedText: false, streamedThinking: false };
    expect(
      mapSdkMessage(
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'x' }] },
          ...base,
          parent_tool_use_id: 'p',
        } as unknown as SDKMessage,
        st,
      ),
    ).toEqual([]);
    const r = mapSdkMessage(
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        usage: {},
        total_cost_usd: 0,
        ...base,
      } as unknown as SDKMessage,
      st,
    );
    expect(r.map((e) => e.type)).toEqual(['usage', 'error', 'done']);
  });
});
