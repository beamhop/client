/**
 * beamhop re-launches `process.execPath <script>` for helpers that must be separate processes (the
 * sandbox runner, the MCP stdio server). In the desktop app `process.execPath` is the Electron app
 * binary, which only behaves as plain Node when `ELECTRON_RUN_AS_NODE=1` is set. Spread this into the
 * env of every such spawn. Elsewhere (plain Node, the standalone binary) it is empty.
 *
 * Never let the variable reach harness processes: an agent that launches an Electron-based tool
 * (VS Code's `code`, for one) would get a bare Node instead. The sandbox runner drops it on start.
 */
export const ELECTRON_RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE';

export const nodeExecEnv = (versions: NodeJS.ProcessVersions = process.versions): Record<string, string> =>
  versions.electron ? { [ELECTRON_RUN_AS_NODE]: '1' } : {};
