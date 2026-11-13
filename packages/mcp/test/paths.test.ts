// docs/security/REVIEW-wave-a.md — MCP-1: channel_send_file path confinement.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openConfinedFile } from '../src/index.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'bh-mcp-paths-')));
const session = join(root, 'session');
const home = join(root, 'home');
const ssh = join(home, '.ssh');
const outside = join(root, 'outside');
for (const d of [session, ssh, outside, join(session, 'sub')]) mkdirSync(d, { recursive: true });
writeFileSync(join(session, 'report.txt'), 'report');
writeFileSync(join(session, 'sub', 'a.png'), 'png');
writeFileSync(join(ssh, 'id_test'), 'FAKE KEY');
writeFileSync(join(outside, 'secret.txt'), 'outside');
writeFileSync(join(home, 'notes.txt'), 'notes');
const posix = process.platform !== 'win32';
if (posix) {
  symlinkSync(join(outside, 'secret.txt'), join(session, 'link-out'));
  symlinkSync(join(session, 'report.txt'), join(session, 'link-in'));
  symlinkSync(outside, join(session, 'dirlink'));
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

const roots = [session, home];
const deny = [ssh];
const read = async (p: string) => {
  const f = await openConfinedFile(p, roots, deny);
  try {
    return (await f.handle.readFile()).toString();
  } finally {
    await f.handle.close();
  }
};
const code = (p: string) =>
  openConfinedFile(p, roots, deny).then(
    async (f) => {
      await f.handle.close();
      return 'ok';
    },
    (e: { code?: string }) => e.code,
  );

describe('openConfinedFile', () => {
  it('opens regular files inside the session dir and mounts (relative paths resolve to the session dir)', async () => {
    expect(await read(join(session, 'report.txt'))).toBe('report');
    expect(await read('sub/a.png')).toBe('png');
    expect(await read(join(home, 'notes.txt'))).toBe('notes');
  });

  it('refuses .. traversal and absolute paths outside the roots', async () => {
    expect(await code('../outside/secret.txt')).toBe('sandbox_violation');
    expect(await code(join(session, '..', 'outside', 'secret.txt'))).toBe('sandbox_violation');
    expect(await code(join(outside, 'secret.txt'))).toBe('sandbox_violation');
  });

  it('refuses denied paths inside a mount (mount contains ~/.ssh)', async () => {
    expect(await code(join(ssh, 'id_test'))).toBe('sandbox_violation');
    expect(await code(join(home, '.ssh', '..', '.ssh', 'id_test'))).toBe('sandbox_violation');
  });

  it.skipIf(!posix)('resolves symlinks before checking (link out is refused, link in is fine)', async () => {
    expect(await code(join(session, 'link-out'))).toBe('sandbox_violation');
    expect(await code(join(session, 'dirlink', 'secret.txt'))).toBe('sandbox_violation');
    expect(await read(join(session, 'link-in'))).toBe('report');
  });

  it('refuses directories, NUL bytes and missing files', async () => {
    expect(await code(join(session, 'sub'))).toBe('sandbox_violation');
    expect(await code(`report.txt\0.png`)).toBe('invalid_input');
    expect(await code('nope.txt')).toBe('not_found');
  });

  it('enforces maxBytes', async () => {
    await expect(openConfinedFile('report.txt', roots, deny, { maxBytes: 2 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});
