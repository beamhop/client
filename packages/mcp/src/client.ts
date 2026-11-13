/** MCP-process side of the bridge: forwards tool calls to the daemon as JSON POSTs. */
import { callTimeoutMs, type ToolName } from './tools.ts';
import { BRIDGE_PATH, type CallResult } from './wire.ts';

export interface BridgeClientOptions {
  /** http://127.0.0.1:<port> */
  url: string;
  token: string;
  fetch?: typeof fetch;
}

export type BridgeCall = (
  tool: ToolName,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<CallResult>;

/** Returns a `call` function that never throws: failures come back as `{ ok: false }`. */
export const createBridgeClient = (opts: BridgeClientOptions): BridgeCall => {
  const doFetch = opts.fetch ?? fetch;
  const endpoint = new URL(BRIDGE_PATH, opts.url).toString();
  return async (tool, input, signal) => {
    const timeout = AbortSignal.timeout(callTimeoutMs(tool, input));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tool, input }),
        signal: combined,
      });
    } catch {
      if (timeout.aborted)
        return {
          ok: false,
          error: { code: 'timeout', message: `${tool}: beamhop daemon did not answer in time` },
        };
      if (signal?.aborted) return { ok: false, error: { code: 'timeout', message: `${tool}: cancelled` } };
      return { ok: false, error: { code: 'unavailable', message: 'beamhop daemon bridge is unreachable' } };
    }
    try {
      const body = (await res.json()) as CallResult;
      if (body && typeof body === 'object' && 'ok' in body) {
        if (body.ok && typeof body.text === 'string') return body;
        if (!body.ok && body.error && typeof body.error.message === 'string') return body;
      }
    } catch {
      // fall through
    }
    return {
      ok: false,
      error: { code: 'internal', message: `bridge returned an unexpected response (HTTP ${res.status})` },
    };
  };
};
