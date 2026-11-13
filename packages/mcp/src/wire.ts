/**
 * Wire format between the sandboxed MCP process and the daemon bridge.
 *
 *   POST <bridgeUrl>/v1/call
 *   Authorization: Bearer <per-session token>
 *   Content-Type: application/json
 *   { "tool": "<tool name>", "input": { ... } }
 *
 * Response (always JSON): { ok: true, text } | { ok: false, error: { code, message } }
 */
import type { ErrorCode } from '@beamhop/core';

export const BRIDGE_PATH = '/v1/call';
export const ENV_URL = 'BEAMHOP_MCP_URL';
export const ENV_TOKEN = 'BEAMHOP_MCP_TOKEN';

export interface CallRequest {
  tool: string;
  input: unknown;
}

export type CallResult =
  | { ok: true; text: string }
  | { ok: false; error: { code: ErrorCode; message: string } };
