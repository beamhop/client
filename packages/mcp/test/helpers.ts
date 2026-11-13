import { isAbsolute, relative, resolve } from 'node:path';
import { BeamhopError, silentLogger } from '@beamhop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  createBeamhopMcpServer,
  createBridgeClient,
  createMcpBridge,
  type McpBridge,
  type McpHandlers,
  nextHop,
} from '../src/index.ts';

export interface FakeCtx {
  sessionId: string;
  conversation: string;
  sessionDir: string;
  mounts: string[];
  routes: string[];
  hops: number;
  maxHops: number;
}

export const NPUB = `npub1${'q'.repeat(58)}`;

export type Calls = { tool: string; ctx: FakeCtx; input: unknown }[];

const inside = (root: string, p: string): boolean => {
  const rel = relative(root, resolve(root, p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Fake daemon handlers that enforce the contract the real daemon must implement. */
export const fakeHandlers = (calls: Calls): McpHandlers<FakeCtx> => {
  const rec = (tool: string, ctx: FakeCtx, input: unknown) => calls.push({ tool, ctx, input });
  return {
    async channel_send(ctx, input) {
      rec('channel_send', ctx, input);
      const target = input.target ?? ctx.conversation;
      if (target !== ctx.conversation && !ctx.routes.includes(target))
        throw new BeamhopError('forbidden', `no route from ${ctx.conversation} to ${target}`);
      return `sent message msg_1 to ${target}`;
    },
    async channel_send_file(ctx, input) {
      rec('channel_send_file', ctx, input);
      const roots = [ctx.sessionDir, ...ctx.mounts];
      if (!roots.some((r) => inside(r, input.path)))
        throw new BeamhopError('sandbox_violation', 'path is outside the session directory and mounts');
      return { messageId: 'msg_2', path: input.path };
    },
    async channel_history(ctx, input) {
      rec('channel_history', ctx, input);
      return {
        messages: Array.from({ length: input.limit }, (_, i) => ({ id: `m${i}`, from: 'Alice', text: 'hi' })),
      };
    },
    async channel_members(ctx, input) {
      rec('channel_members', ctx, input);
      return [{ name: 'Alice', principal: 'telegram:5551', role: 'owner' }];
    },
    async mesh_list_agents(ctx, input) {
      rec('mesh_list_agents', ctx, input);
      return { agents: [{ npub: NPUB, name: 'reviewer', jobKinds: [5050] }] };
    },
    async mesh_ask_agent(ctx, input) {
      const hops = nextHop(ctx.hops, ctx.maxHops);
      rec('mesh_ask_agent', ctx, { ...input, hops });
      return `reply from ${input.npub} (hops=${hops})`;
    },
    async mesh_post_job(ctx, input) {
      rec('mesh_post_job', ctx, input);
      return { jobId: 'job_1', status: 'pending' };
    },
    async mesh_job_result(ctx, input) {
      rec('mesh_job_result', ctx, input);
      if (input.jobId !== 'job_1') throw new BeamhopError('not_found', 'unknown job');
      return { jobId: 'job_1', status: 'success', content: '42' };
    },
    async session_status(ctx, input) {
      rec('session_status', ctx, input);
      return { agent: 'reviewer', role: 'user', permissionMode: 'ask', budget: { dailyUsdLeft: 4.2 } };
    },
  };
};

export const defaultCtx = (over: Partial<FakeCtx> = {}): FakeCtx => ({
  sessionId: 'ses_1',
  conversation: 'mybot:dm/42',
  sessionDir: resolve('/tmp/beamhop-test/ses_1'),
  mounts: [resolve('/tmp/beamhop-test/repo')],
  routes: ['work-slack:channel/C0123'],
  hops: 0,
  maxHops: 3,
  ...over,
});

export interface Harness {
  bridge: McpBridge<FakeCtx>;
  token: string;
  calls: Calls;
  connect(token?: string): Promise<Client>;
  close(): Promise<void>;
}

export const setup = async (
  ctx: FakeCtx = defaultCtx(),
  handlers?: (calls: Calls) => McpHandlers<FakeCtx>,
): Promise<Harness> => {
  const calls: Calls = [];
  const bridge = await createMcpBridge({ handlers: (handlers ?? fakeHandlers)(calls), log: silentLogger });
  const token = bridge.addSession(ctx);
  const clients: Client[] = [];
  return {
    bridge,
    token,
    calls,
    async connect(tok = token) {
      const server = createBeamhopMcpServer({ call: createBridgeClient({ url: bridge.url, token: tok }) });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '0.0.0' });
      await Promise.all([server.connect(b), client.connect(a)]);
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((c) => c.close()));
      await bridge.close();
    },
  };
};

export const text = (r: unknown): string => {
  const c = (r as CallToolResult).content[0];
  return c && c.type === 'text' ? c.text : '';
};
