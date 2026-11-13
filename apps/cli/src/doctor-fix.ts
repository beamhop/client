/**
 * `beamhop doctor --fix`: apply the fixes the daemon knows (`DoctorCheck.action`). Fixes that need
 * administrator rights run here with `sudo` and the terminal's own stdio, so the password goes to sudo,
 * never to beamhop. Without a terminal (and without --yes) the command is printed instead.
 */
import type { BeamhopClient } from '@beamhop/client';
import type { DoctorCheck } from '@beamhop/core';
import pc from 'picocolors';

export interface FixIO {
  out(line: string): void;
  /** A terminal is attached: we may ask before running sudo. */
  interactive: boolean;
  /** Yes/no on the terminal. */
  confirm(message: string): Promise<boolean>;
  /** Run argv with inherited stdin (sudo reads the password from the terminal); resolves to the exit code. */
  runInherit(argv: string[]): Promise<number>;
  /** The daemon runs on another computer (BEAMHOP_URL): sudo here would fix the wrong one. */
  remote: boolean;
}

export interface FixOptions {
  /** Check ids (or action ids) to fix; empty = every check that is not ok and has an action. */
  ids: string[];
  /** Run admin fixes without asking. */
  yes: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

export type FixOutcome = 'fixed' | 'failed' | 'declined' | 'manual';

export interface FixReport {
  fixes: { check: string; action: string; admin: boolean; outcome: FixOutcome; message?: string }[];
  checks: DoctorCheck[];
  exitCode: number;
}

/** Display form of an argv, quoted for a POSIX shell where needed. */
export const shellLine = (argv: string[]): string =>
  argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');

/** argv for an admin fix: `sudo -- <command…>`. */
export const sudoArgv = (command: string[]): string[] => {
  if (!command.length || !command[0]) throw new Error('the daemon sent an empty fix command');
  return ['sudo', '--', ...command];
};

const needsFix = (k: DoctorCheck) => k.status !== 'ok' && k.status !== 'skip' && Boolean(k.action);

export const runDoctorFix = async (c: BeamhopClient, fio: FixIO, o: FixOptions): Promise<FixReport> => {
  const say = (l: string) => {
    if (!o.quiet) fio.out(l);
  };
  const before = (await c.call('system.doctor')).checks;
  const wanted = new Set(o.ids);
  const matches = (k: DoctorCheck) => wanted.has(k.id) || (k.action ? wanted.has(k.action.id) : false);
  if (wanted.size) {
    const known = new Set(before.flatMap((k) => [k.id, ...(k.action ? [k.action.id] : [])]));
    const unknown = o.ids.filter((id) => !known.has(id));
    if (unknown.length)
      throw new Error(
        `no doctor check ${unknown.join(', ')}. Checks with a fix: ${
          before
            .filter((k) => k.action)
            .map((k) => k.id)
            .join(', ') || 'none'
        }`,
      );
    for (const k of before.filter(matches)) {
      if (!k.action)
        say(pc.yellow(`! ${k.title}: beamhop cannot fix this one itself.${k.fix ? ` ${k.fix}` : ''}`));
      else if (!needsFix(k)) say(pc.dim(`${k.title}: nothing to fix.`));
    }
  }
  const todo = before.filter((k) => needsFix(k) && (!wanted.size || matches(k)));
  const fixes: FixReport['fixes'] = [];
  if (!todo.length) say(pc.dim('nothing to fix.'));

  for (const k of todo) {
    const a = k.action!;
    const rec = { check: k.id, action: a.id, admin: a.admin };
    say(`${pc.bold(k.title)}: ${a.summary}`);
    if (!a.admin) {
      try {
        const r = await c.call('system.doctorFix', { id: a.id, elevate: 'none' });
        const after = r.checks.find((x) => x.id === k.id);
        const ok = !after || after.status === 'ok' || after.status === 'skip';
        if (o.verbose || !ok)
          for (const l of r.output.trim().split('\n').filter(Boolean)) say(pc.dim(`  │ ${l}`));
        if (ok) {
          say(`${pc.green('✓')} ${a.label}`);
          fixes.push({ ...rec, outcome: 'fixed' });
          continue;
        }
        say(`${pc.red('✗')} ${a.label} did not fix it${after?.message ? `: ${after.message}` : ''}`);
        fixes.push({ ...rec, outcome: 'failed', ...(after?.message ? { message: after.message } : {}) });
      } catch (e) {
        say(`${pc.red('✗')} ${a.label} failed: ${(e as Error).message}`);
        fixes.push({ ...rec, outcome: 'failed', message: (e as Error).message });
      }
      break; // stop at the first fix that did not work
    }

    const argv = sudoArgv(a.command);
    const shown = shellLine(['sudo', ...a.command]);
    if (fio.remote || (!o.yes && !fio.interactive)) {
      say(
        `${pc.yellow('!')} needs administrator rights. ${fio.remote ? 'On the computer running the daemon, run' : 'Run'}:\n    ${pc.bold(shown)}\n  then check again with ${pc.bold('beamhop doctor')}`,
      );
      fixes.push({ ...rec, outcome: 'manual' });
      continue;
    }
    if (!o.yes) {
      say(`  this runs with administrator rights (sudo asks for your password):\n    ${pc.bold(shown)}`);
      if (!(await fio.confirm('Run it now?'))) {
        say(pc.dim('  skipped.'));
        fixes.push({ ...rec, outcome: 'declined' });
        continue;
      }
    } else say(pc.dim(`  $ ${shown}`));
    const code = await fio.runInherit(argv);
    if (code === 0) {
      say(`${pc.green('✓')} ${a.label}`);
      fixes.push({ ...rec, outcome: 'fixed' });
      continue;
    }
    say(`${pc.red('✗')} ${shown} exited with ${code}`);
    fixes.push({ ...rec, outcome: 'failed', message: `exit code ${code}` });
    break;
  }

  const checks = fixes.length ? (await c.call('system.doctor')).checks : before;
  const targeted = new Set(todo.map((k) => k.id));
  const stillBad = checks.some((k) => targeted.has(k.id) && k.status !== 'ok' && k.status !== 'skip');
  return { fixes, checks, exitCode: stillBad ? 1 : 0 };
};

/** True when BEAMHOP_URL points at a daemon on another computer. */
export const isRemoteDaemon = (env: Record<string, string | undefined>): boolean => {
  if (!env.BEAMHOP_URL) return false;
  try {
    const h = new URL(env.BEAMHOP_URL).hostname;
    return !['localhost', '127.0.0.1', '[::1]', '::1'].includes(h);
  } catch {
    return false;
  }
};
