/** Pure helpers for the Harnesses screen (unit-tested). */
import { type HarnessView, type InstallManager, installCommand } from '@beamhop/core';

export type Os = 'mac' | 'linux' | 'windows';

/** Best guess for the viewer's OS (the default tab of the Install sheet; the user can switch). */
export const detectOs = (
  nav: { userAgent?: string; platform?: string; userAgentData?: { platform?: string } } = navigator,
): Os => {
  const p = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent ?? ''}`.toLowerCase();
  // mac first: "darwin" contains "win".
  if (p.includes('mac') || p.includes('darwin') || p.includes('iphone') || p.includes('ipad')) return 'mac';
  if (p.includes('win')) return 'windows';
  return 'linux';
};

export interface InstallOption {
  manager: InstallManager;
  label: string;
  command: string;
}

const ORDER: Record<Os, InstallOption['manager'][]> = {
  mac: ['brew', 'npm'],
  linux: ['npm', 'brew'],
  windows: ['winget', 'npm'],
};
const LABEL: Record<InstallOption['manager'], string> = { npm: 'npm', brew: 'Homebrew', winget: 'winget' };

/** Install commands that make sense on `os`, best first. */
export const installOptions = (h: Pick<HarnessView, 'install'>, os: Os): InstallOption[] =>
  ORDER[os]
    .map((m) => ({ manager: m, label: LABEL[m], command: installCommand(m, h.install?.[m] ?? '') }))
    .filter((o) => o.command.length > 0);

/** OSes for which this harness has at least one command. */
export const supportedOses = (h: Pick<HarnessView, 'install'>): Os[] =>
  (['mac', 'linux', 'windows'] as Os[]).filter((os) => installOptions(h, os).length > 0);

/** `Run: codex login` → `codex login`; falls back to `<command> login`. */
export const loginCommand = (h: Pick<HarnessView, 'message' | 'command'>): string => {
  const m = /run:\s*(.+)$/i.exec(h.message ?? '');
  return (m?.[1] ?? `${h.command} login`).trim();
};

/** Split a shell-ish command line into command + args (quotes respected, no expansion). */
export const splitCommand = (line: string): { command: string; args: string[] } => {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let had = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      had = true;
    } else if (/\s/.test(ch)) {
      if (cur || had) parts.push(cur);
      cur = '';
      had = false;
    } else cur += ch;
  }
  if (cur || had) parts.push(cur);
  return { command: parts[0] ?? '', args: parts.slice(1) };
};

/** Harness ids are slugs; derived from the command's basename when the user leaves the name empty. */
export const idFromCommand = (command: string): string =>
  (command.split(/[\\/]/).pop() ?? '')
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

export type HarnessGroup = 'ready' | 'attention' | 'missing';
export const groupOf = (h: HarnessView): HarnessGroup =>
  h.status === 'ready' ? 'ready' : h.status === 'not-installed' ? 'missing' : 'attention';

export const STATUS_WORD: Record<HarnessView['status'], string> = {
  ready: 'ready',
  'needs-login': 'needs login',
  'not-installed': 'not installed',
  'unsupported-version': 'update needed',
  error: 'error',
};
