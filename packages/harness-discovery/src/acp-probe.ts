import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { BeamhopError, type SandboxHandle, VERSION } from '@beamhop/core';
import {
  captureStderr,
  minimalEnv,
  spawnInSandbox,
  spawnProcess,
  terminate,
  truncate,
} from '@beamhop/harness-kit';

export interface AcpProbeResult {
  ok: boolean;
  protocolVersion?: number;
  agentInfo?: { name: string; title?: string | null; version: string };
  agentCapabilities?: acp.AgentCapabilities;
  authMethods?: acp.AuthMethod[];
  /** Mapped to the HarnessDetection capability shape. */
  capabilities?: { streaming: boolean; permissions: boolean; resume: boolean; mcp: boolean; images: boolean };
  error?: string;
  durationMs: number;
}

export interface AcpProbeOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  /** Run the probe inside this sandbox (recommended for unknown commands). */
  sandbox?: SandboxHandle;
}

export const CLIENT_INFO = { name: 'beamhop', title: 'beamhop', version: VERSION } as const;

export const mapAcpCapabilities = (c: acp.AgentCapabilities | undefined) => ({
  streaming: true,
  permissions: true,
  resume: Boolean(c?.loadSession || c?.sessionCapabilities?.resume),
  mcp: true,
  images: Boolean(c?.promptCapabilities?.image),
});

/** Turn a child's stdio into the SDK's ndjson stream. */
export const acpStreamFor = (child: { stdin: Writable; stdout: Readable }): acp.Stream =>
  acp.ndJsonStream(
    Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );

/**
 * Spawn `cmd args`, send ACP `initialize`, and report what the agent advertises.
 * The process is always terminated afterwards. Never throws.
 */
export const probeAcpCommand = async (
  cmd: string,
  args: string[] = [],
  opts: AcpProbeOptions = {},
): Promise<AcpProbeResult> => {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15000;
  const env = opts.env ?? minimalEnv();
  let child: Awaited<ReturnType<typeof spawnProcess>> | undefined;
  try {
    child = opts.sandbox
      ? await spawnInSandbox(opts.sandbox, { cmd, args, env, cwd: opts.cwd })
      : spawnProcess({ cmd, args, env, cwd: opts.cwd });
    const proc = child;
    const stderr = captureStderr(proc);
    const exited = new Promise<never>((_, reject) => {
      proc.once('error', (e) => reject(new BeamhopError('unavailable', `spawn failed: ${e.message}`)));
      proc.once('exit', (code, signal) =>
        reject(
          new BeamhopError(
            'unavailable',
            `agent exited before initialize (code=${code} signal=${signal})${stderr() ? `: ${truncate(stderr(), 400)}` : ''}`,
          ),
        ),
      );
    });
    const conn = acp.client({ name: CLIENT_INFO.name }).connect(acpStreamFor(proc));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new BeamhopError('timeout', `initialize timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      const res = await Promise.race([
        conn.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
          clientInfo: CLIENT_INFO,
        }) as Promise<acp.InitializeResponse>,
        exited,
        timeout,
      ]);
      return {
        ok: true,
        protocolVersion: res.protocolVersion,
        agentInfo: res.agentInfo ?? undefined,
        agentCapabilities: res.agentCapabilities,
        authMethods: res.authMethods,
        capabilities: mapAcpCapabilities(res.agentCapabilities),
        durationMs: Date.now() - started,
      };
    } finally {
      if (timer) clearTimeout(timer);
      exited.catch(() => {});
      conn.close();
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started };
  } finally {
    if (child) await terminate(child, 500);
  }
};
