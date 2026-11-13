// fs.list (path picker): directories only, confined to $HOME and configured roots, hidden and
// ALWAYS_DENY_READ entries left out, symlinks out of the roots dropped. HOME points at a temp dir
// for this file (each test file runs in its own process).
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RpcError } from '@beamhop/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv, tmpHome } from './helpers.ts';

const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'bh-home-')));
let env: TestEnv | undefined;
const code = (e: unknown) => (e as RpcError).beamhopCode ?? (e as { code?: string }).code;

beforeAll(() => {
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  for (const d of [
    'code/app/.git',
    'code/site',
    'code/.hidden',
    'Library/Keychains',
    'Library/Fonts',
    '.ssh',
  ])
    mkdirSync(join(fakeHome, d), { recursive: true });
  writeFileSync(join(fakeHome, 'code', 'notes.txt'), 'not a dir');
});
afterEach(async () => {
  await env?.close();
  env = undefined;
});

describe.skipIf(process.platform === 'win32')('fs.list', () => {
  it('lists directories under home, marks git repos, hides hidden and denied entries', async () => {
    env = await makeEnv();
    const home = await env.client.call('fs.list', {});
    expect(home.path).toBe('~');
    expect(home.parent).toBeUndefined();
    expect(home.roots).toEqual(['~']);
    expect(home.entries.map((e) => e.name).sort()).toEqual(['Library', 'code']);
    const code_ = await env.client.call('fs.list', { path: '~/code' });
    expect(code_).toEqual({
      path: '~/code',
      parent: '~',
      roots: ['~'],
      entries: [
        { name: 'app', path: '~/code/app', git: true },
        { name: 'site', path: '~/code/site', git: false },
      ],
    });
    const lib = await env.client.call('fs.list', { path: join(fakeHome, 'Library') });
    expect(lib.entries.map((e) => e.name)).toEqual(['Fonts']);
  });

  it('refuses denied paths, paths outside the roots, files and escaping links', async () => {
    env = await makeEnv();
    const refuse = async (path: string, want: string) =>
      expect(env!.client.call('fs.list', { path })).rejects.toSatisfy((e) => code(e) === want);
    await refuse('~/.ssh', 'forbidden');
    await refuse('~/Library/Keychains', 'forbidden');
    await refuse('/etc', 'forbidden');
    await refuse('~/../', 'forbidden');
    await refuse('relative/path', 'invalid_input');
    await refuse('~/code/notes.txt', 'invalid_input');
    await refuse('~/missing', 'not_found');
    const outside = tmpHome();
    mkdirSync(join(outside, 'x'));
    symlinkSync(outside, join(fakeHome, 'code', 'link-out'));
    symlinkSync(join(fakeHome, '.ssh'), join(fakeHome, 'code', 'link-ssh'));
    symlinkSync(join(fakeHome, 'code', 'site'), join(fakeHome, 'code', 'link-site'));
    const names = (await env.client.call('fs.list', { path: '~/code' })).entries.map((e) => e.name);
    expect(names).toEqual(['app', 'link-site', 'site']);
    await refuse('~/code/link-out', 'forbidden');
  });

  it('extra roots from the daemon options can be browsed', async () => {
    const extra = tmpHome();
    mkdirSync(join(extra, 'repo', '.git'), { recursive: true });
    env = await makeEnv({ fsRoots: [extra] });
    const r = await env.client.call('fs.list', { path: extra });
    expect(r.roots).toEqual(['~', extra]);
    expect(r.entries).toEqual([{ name: 'repo', path: join(extra, 'repo'), git: true }]);
    expect(r.parent).toBeUndefined();
  });
});
