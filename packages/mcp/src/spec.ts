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
 * the node binary (`mcpReadPaths()`), and must allow `127.0.0.1:<bridge port>` (`localAllow`). On
 * Linux the sandbox forwards that port inside its network namespace, so plain `fetch` reaches it;
 * on macOS the client goes through srt's proxy (`envProxyFetch`).
 */
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nodeExecEnv } from '@beamhop/core';
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
  env: { ...nodeExecEnv(), [ENV_URL]: bridgeUrl, [ENV_TOKEN]: sessionToken },
});

/**
 * Paths the sandbox must be able to read for the stdio entry to start: this package, the
 * `node_modules` trees its runtime deps (tsx loader, MCP SDK, zod, undici, @beamhop/core) resolve
 * into, and the node installation. Add them to the policy's `fs.read` (they only matter when the
 * sandbox isolates HOME, but listing them keeps the requirement explicit).
 */
export const mcpReadPaths = (): string[] => {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const out = new Set<string>([real(MCP_PACKAGE_DIR)]);
  const req = createRequire(import.meta.url);
  for (const dep of ['tsx', '@modelcontextprotocol/sdk/server/stdio.js', 'zod', 'undici', '@beamhop/core']) {
    try {
      const file = real(req.resolve(dep));
      // The outermost node_modules holds the dep and its siblings (pnpm's .pnpm store included);
      // a workspace package (realpath outside node_modules) is <pkg>/src/index.ts.
      const nm = file.indexOf(`${sep}node_modules${sep}`);
      out.add(nm === -1 ? dirname(dirname(file)) : file.slice(0, nm + `${sep}node_modules`.length));
    } catch {
      // optional
    }
  }
  // node itself: <prefix>/bin/node -> <prefix> (some installs ship shared libs next to bin/).
  // Desktop app: beamhop.app/Contents/MacOS/beamhop -> Contents (Frameworks/ holds the runtime);
  // on Windows and Linux the app's own install directory.
  const exe = real(process.execPath);
  out.add(process.versions.electron && process.platform !== 'darwin' ? dirname(exe) : dirname(dirname(exe)));
  return [...out];
};
