/** Stdio entry logic for the `beamhop-mcp` process (see bin/beamhop-mcp.ts). */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridgeClient } from './client.ts';
import { createBeamhopMcpServer } from './server.ts';
import { ENV_TOKEN, ENV_URL } from './wire.ts';

/** Validates env; returns bridge url+token or an error message. Only loopback http URLs are accepted. */
export const readBridgeEnv = (
  env: Record<string, string | undefined>,
): { url: string; token: string } | { error: string } => {
  const url = env[ENV_URL];
  const token = env[ENV_TOKEN];
  if (!url || !token) return { error: `${ENV_URL} and ${ENV_TOKEN} must be set` };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `${ENV_URL} is not a valid URL` };
  }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
    return { error: `${ENV_URL} must be a loopback http URL` };
  return { url, token };
};

export const runStdio = async (env: Record<string, string | undefined> = process.env): Promise<void> => {
  const cfg = readBridgeEnv(env);
  if ('error' in cfg) {
    process.stderr.write(`beamhop-mcp: ${cfg.error}\n`);
    process.exit(2);
  }
  const server = createBeamhopMcpServer({ call: createBridgeClient(cfg) });
  const transport = new StdioServerTransport();
  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await server.connect(transport);
};
