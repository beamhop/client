import { type SandboxHandle, SandboxPolicy } from '@beamhop/core';

/**
 * A SandboxHandle that does NOT isolate anything: the command runs as-is.
 * Only for unit/live tests and for `beamhop harness scan` when no sandbox backend is
 * available. Never use it for sessions that run untrusted input.
 */
export const unsafePassthroughSandbox = (env: Record<string, string> = {}): SandboxHandle => ({
  backend: 'passthrough',
  policy: SandboxPolicy.parse({}),
  wrap: async (cmd, args) => ({ cmd, args, env }),
});

/** Minimal env for a child process when the caller gives none: PATH and friends only. */
export const minimalEnv = (src: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const keys = [
    'PATH',
    'Path',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'ComSpec',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'TERM',
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
};
