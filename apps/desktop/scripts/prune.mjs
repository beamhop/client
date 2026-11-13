// Drop what the bundled daemon never loads on the target platform from its production node_modules.
// Used by scripts/build.mjs after `npm install`; idempotent.
//
//   @microsoft/mxc-sdk (+ node-pty, koffi)  srt's optional Windows "mxc" backend. beamhop always uses
//                                           srt's default Windows backend (srt-win), and srt only
//                                           probes for mxc-sdk (isMxcSdkInstalled), so it can go everywhere.
//   sandbox-runtime/vendor/seccomp          Linux only (seccomp filters), and only this arch.
//   sandbox-runtime/vendor/srt-win          Windows only, and only this arch.
//   *.map, *.d.ts                           source maps and type declarations.
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Size of a file or directory tree, without following symlinks. */
const sizeOf = (p) => {
  const st = lstatSync(p);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(p)) n += sizeOf(join(p, e));
  return n;
};

/** Paths (relative to node_modules) to remove for `platform`/`arch`. */
export const prunePlan = (nm, platform, arch) => {
  const out = ['@microsoft/mxc-sdk', 'node-pty', 'koffi'];
  if (existsSync(join(nm, '@koromix'))) out.push('@koromix');
  const vendor = '@anthropic-ai/sandbox-runtime/vendor';
  const keepOnly = (dir, keep) => {
    const abs = join(nm, dir);
    if (!existsSync(abs)) return;
    if (!keep) out.push(dir);
    else for (const e of readdirSync(abs)) if (e !== keep) out.push(`${dir}/${e}`);
  };
  keepOnly(`${vendor}/seccomp`, platform === 'linux' ? arch : undefined);
  keepOnly(`${vendor}/srt-win`, platform === 'win32' ? arch : undefined);
  return out.filter((p) => existsSync(join(nm, p)));
};

const TYPING_OR_MAP = /\.(map|d\.ts|d\.mts|d\.cts)$/;

const typingsAndMaps = (dir, rel = '') => {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...typingsAndMaps(dir, r));
    else if (e.isFile() && TYPING_OR_MAP.test(e.name)) out.push(r);
  }
  return out;
};

/** Remove everything in the plan plus maps/typings. Returns the bytes freed. */
export const pruneDaemonDeps = (nm, platform = process.platform, arch = process.arch) => {
  if (!existsSync(nm)) return 0;
  let freed = 0;
  for (const rel of [...prunePlan(nm, platform, arch), ...typingsAndMaps(nm)]) {
    const p = join(nm, rel);
    if (!existsSync(p)) continue;
    freed += sizeOf(p);
    rmSync(p, { recursive: true, force: true });
  }
  return freed;
};
