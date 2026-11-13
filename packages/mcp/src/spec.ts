/**
 * How the harness launches the beamhop MCP server.
 *
 * The server is a separate stdio process (spawned by the harness, inside the sandbox). It is started as
 *
 *   node dist/bin/beamhop-mcp.js                                     (compiled build, if present)
 *   node --import <abs file URL of tsx loader> <pkg>/bin/beamhop-mcp.ts   (source, the default in dev)
 *
 * with `BEAMHOP_MCP_URL` (http://127.0.0.1:<port> of the daemon bridge) and `BEAMHOP_MCP_TOKEN`
 * (per-session token) in its env. The tsx loader is resolved to an absolute file URL so it works
 * regardless of the session's cwd (and on Windows, where `--import` needs URLs for absolute paths).
 *
 * Sandbox requirements: the sandbox must allow reading this package, its node_modules (tsx, SDK) and
 * the node binary, and must allow connecting to 127.0.0.1:<bridge port>.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MCP_SERVER_NAME } from './server.ts';
import { ENV_TOKEN, ENV_URL } from './wire.ts';

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Package root (…/packages/mcp). */
export const MCP_PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MCP_TS_ENTRY = join(MCP_PACKAGE_DIR, 'bin', 'beamhop-mcp.ts');
export const MCP_JS_ENTRY = join(MCP_PACKAGE_DIR, 'dist', 'bin', 'beamhop-mcp.js');

/** `node` arguments that start the stdio entry (compiled JS if built, else TS through tsx). */
export const mcpEntryArgs = (): string[] => {
  if (existsSync(MCP_JS_ENTRY)) return [MCP_JS_ENTRY];
  const tsxLoader = createRequire(import.meta.url).resolve('tsx');
  return ['--import', pathToFileURL(tsxLoader).href, MCP_TS_ENTRY];
};

/** Entry for `SessionSpec.mcpServers`. */
export const mcpServerSpec = (sessionToken: string, bridgeUrl: string): McpServerSpec => ({
  name: MCP_SERVER_NAME,
  command: process.execPath,
  args: mcpEntryArgs(),
  env: { [ENV_URL]: bridgeUrl, [ENV_TOKEN]: sessionToken },
});
