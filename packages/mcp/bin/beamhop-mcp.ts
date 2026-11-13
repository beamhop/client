#!/usr/bin/env node
/**
 * beamhop MCP server (stdio). Spawned by the harness inside the sandbox.
 *
 *   BEAMHOP_MCP_URL=http://127.0.0.1:<port> BEAMHOP_MCP_TOKEN=<token> \
 *     node --import tsx packages/mcp/bin/beamhop-mcp.ts
 *
 * Use `mcpServerSpec()` from @beamhop/mcp to get the exact command line (it resolves tsx absolutely).
 */
import { runStdio } from '../src/stdio.ts';

runStdio().catch((e) => {
  process.stderr.write(`beamhop-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
