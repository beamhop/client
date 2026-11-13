// pi extension loaded by @beamhop/harness-pi in "ask" permission mode.
// pi has no built-in approvals; this gate asks the RPC client through the extension UI
// sub-protocol (extension_ui_request method "confirm"), which beamhop maps to permission_request.
const READ_ONLY = new Set(['read', 'grep', 'find', 'ls']);
const PREFIX = 'beamhop-permission:';

export default function beamhopGate(pi) {
  pi.on('tool_call', async (event, ctx) => {
    if (READ_ONLY.has(event.toolName)) return undefined;
    if (!ctx.hasUI) return { block: true, reason: 'beamhop: no approval channel' };
    const payload = JSON.stringify({
      toolCallId: event.toolCallId,
      tool: event.toolName,
      input: event.input,
    });
    const ok = await ctx.ui.confirm(`${PREFIX}${payload}`, `Allow ${event.toolName}?`);
    return ok ? undefined : { block: true, reason: 'denied by the owner' };
  });
}
