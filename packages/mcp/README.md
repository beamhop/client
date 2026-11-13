# @beamhop/mcp

The beamhop MCP server injected into every harness session (PLAN §3.2, §3.3, §6A.3, §6A.6).

```
harness ──stdio──▶ beamhop-mcp (in sandbox) ──HTTP POST, Bearer token──▶ daemon bridge (127.0.0.1) ──▶ handlers
```

## Daemon side

```ts
import { createMcpBridge } from '@beamhop/mcp';

const bridge = await createMcpBridge({ handlers, log }); // handlers: McpHandlers<YourSessionCtx>
const token = bridge.addSession(ctx);                     // one token per harness session
spec.mcpServers.push(bridge.spec(token));                 // = mcpServerSpec(token, bridge.url)
// on session end:
bridge.removeSession(token);                              // revokes token, aborts in-flight calls
```

The bridge validates the token and all input (zod, same schemas as the MCP server; history `limit` is
clamped to 50, Markdown is capped at 20k chars). **Policy stays with the handlers**: routes for
`channel_send` targets, path confinement for `channel_send_file`, DLP, budgets, and hops (use
`nextHop(ctx.hops, maxHops)` in `mesh_ask_agent`/`mesh_post_job`). Throw `BeamhopError` for a clean
tool error; any other error is reported to the model as a generic internal error.

## Process side

`mcpServerSpec()` returns `{ name: 'beamhop', command: process.execPath, args, env }` where `args` is

- `[<pkg>/dist/bin/beamhop-mcp.js]` if a compiled build exists, else
- `['--import', <absolute file URL of tsx's loader>, <pkg>/bin/beamhop-mcp.ts]`.

Manual run: `BEAMHOP_MCP_URL=http://127.0.0.1:<port> BEAMHOP_MCP_TOKEN=<token> node --import tsx packages/mcp/bin/beamhop-mcp.ts`.

The sandbox profile must allow reading this package, its `node_modules` and the node binary, and
connecting to `127.0.0.1:<bridge port>`.

## Tools

`channel_send`, `channel_send_file`, `channel_history`, `channel_members`, `mesh_list_agents`,
`mesh_ask_agent`, `mesh_post_job`, `mesh_job_result`, `session_status`. All results are text
(objects are pretty JSON); failures are MCP tool errors (`isError: true`, text `"<code>: <message>"`).
