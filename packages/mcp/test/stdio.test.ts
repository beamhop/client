import { spawn } from 'node:child_process';
import { silentLogger } from '@beamhop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpBridge, type McpBridge, mcpEntryArgs, TOOL_NAMES } from '../src/index.ts';
import { type Calls, defaultCtx, type FakeCtx, fakeHandlers, text } from './helpers.ts';

let bridge: McpBridge<FakeCtx> | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await bridge?.close();
  client = undefined;
  bridge = undefined;
});

describe('stdio entry (node + tsx)', () => {
  it('starts, lists tools and round-trips a call through the bridge', async () => {
    const calls: Calls = [];
    bridge = await createMcpBridge({ handlers: fakeHandlers(calls), log: silentLogger });
    const token = bridge.addSession(defaultCtx());
    const spec = bridge.spec(token);
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: { ...getDefaultEnvironment(), ...spec.env },
      stderr: 'pipe',
    });
    client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe('beamhop');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const r = await client.callTool({ name: 'channel_history', arguments: { limit: 1000 } });
    expect(JSON.parse(text(r)).messages).toHaveLength(50);
    expect(calls[0]!.ctx.sessionId).toBe('ses_1');
  });

  it('exits with code 2 when the bridge env is missing', async () => {
    const env = { ...process.env };
    delete env.BEAMHOP_MCP_URL;
    delete env.BEAMHOP_MCP_TOKEN;
    const child = spawn(process.execPath, mcpEntryArgs(), { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(2);
    expect(stderr).toMatch(/BEAMHOP_MCP_URL and BEAMHOP_MCP_TOKEN must be set/);
  });
});
