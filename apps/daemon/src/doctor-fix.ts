/**
 * Doctor fixes (`system.doctorFix`): a fixed table of actions keyed by id. Clients name an id; the
 * command always comes from this table (or the sandbox's own table), never from the caller.
 *
 * Admin fixes go through the OS's own prompt: the macOS administrator dialog (`osascript … with
 * administrator privileges`) or `pkexec` on Linux. beamhop never sees the password.
 */
import { execFile } from 'node:child_process';
import { BeamhopError, type DoctorCheck } from '@beamhop/core';
import { sandboxActions } from '@beamhop/sandbox';

export type DoctorAction = NonNullable<DoctorCheck['action']>;

/** Actions the daemon runs itself (no command). */
export const DAEMON_ACTIONS: Record<string, DoctorAction> = {
  'system.resume': {
    id: 'system.resume',
    label: 'Resume',
    summary: 'Ends panic mode: agents and channels start working again.',
    admin: false,
    command: ['beamhop', 'resume'],
  },
};

/** Every fix this computer can offer, by id. */
export const doctorActionTable = (
  sandbox: Record<string, DoctorAction> = sandboxActions(),
): Record<string, DoctorAction> => ({ ...sandbox, ...DAEMON_ACTIONS });

/** POSIX shell quoting for one argument. */
export const shQuote = (s: string): string =>
  /^[A-Za-z0-9_./=:@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** AppleScript string literal body. */
const asString = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * argv that runs `command` with administrator rights through the OS prompt, or a `forbidden`/`unavailable`
 * error explaining why it can't.
 */
export const elevatedArgv = (
  platform: NodeJS.Platform,
  command: string[],
  which: (cmd: string) => string | undefined,
): { cmd: string; args: string[] } => {
  if (platform === 'darwin') {
    const shell = command.map(shQuote).join(' ');
    return {
      cmd: which('osascript') ?? '/usr/bin/osascript',
      args: ['-e', `do shell script "${asString(shell)}" with administrator privileges`],
    };
  }
  if (platform === 'linux') {
    const pkexec = which('pkexec');
    if (!pkexec)
      throw new BeamhopError(
        'unavailable',
        'This computer has no way to ask for an administrator password from the app (pkexec is missing). Run `beamhop doctor --fix` in a terminal; it uses sudo.',
      );
    return { cmd: pkexec, args: command };
  }
  throw new BeamhopError(
    'unavailable',
    'Fixes that need administrator rights are not supported on this system.',
  );
};

export interface FixRunResult {
  code: number | null;
  output: string;
}

export type FixRunner = (cmd: string, args: string[]) => Promise<FixRunResult>;

export const defaultFixRunner =
  (env: NodeJS.ProcessEnv): FixRunner =>
  (cmd, args) =>
    new Promise((res) => {
      execFile(
        cmd,
        args,
        { env, timeout: 10 * 60_000, maxBuffer: 8 << 20, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err
            ? typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : 1
            : 0;
          res({
            code,
            output: `${stdout ?? ''}${stderr ?? ''}${err && !stdout && !stderr ? String(err.message) : ''}`,
          });
        },
      );
    });

/** Plain-language failure for an elevated run. */
export const elevatedFailure = (platform: NodeJS.Platform, r: FixRunResult): string => {
  if (platform === 'darwin' && /User canceled|-128/.test(r.output))
    return 'The administrator prompt was cancelled.';
  if (platform === 'linux' && r.code === 126) return 'The administrator prompt was cancelled or not allowed.';
  if (platform === 'linux' && r.code === 127)
    return "The administrator prompt couldn't be shown (no polkit agent). Run `beamhop doctor --fix` in a terminal; it uses sudo.";
  return `The fix failed (exit code ${r.code}). See the output.`;
};
