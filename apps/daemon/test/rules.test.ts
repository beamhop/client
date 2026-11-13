// "Always" approval rules, policy suggestion widening, compare URLs: the strict validation edges.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareUrl, stripCredentials } from '../src/git-ops.ts';
import { buildRule, cleanReason, ruleMatches, suggestionValue, withRule } from '../src/rules.ts';

const meta = { at: '2026-11-13T10:00:00Z', by: 'local:owner' };
const bash = (command: string) => ({ tool: 'bash', input: { command }, role: 'user' });
const fetchReq = (url: string) => ({ tool: 'WebFetch', input: { url }, role: 'user' });
const write = (file_path: string) => ({ tool: 'Write', input: { file_path }, role: 'user' });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'ok';
};

describe('command rules', () => {
  it('exact by default; prefix at a word boundary with bash:', () => {
    const exact = buildRule(bash('npm test -- --watch'), undefined, meta);
    expect(exact).toMatchObject({ kind: 'command', value: 'npm test -- --watch', exact: true, role: 'user' });
    expect(ruleMatches(exact, bash('npm test -- --watch'))).toBe(true);
    expect(ruleMatches(exact, bash('npm test'))).toBe(false);

    const pre = buildRule(bash('npm test -- --watch'), 'bash:npm test', meta);
    expect(pre).toMatchObject({ kind: 'command', value: 'npm test' });
    expect(pre.exact).toBeUndefined();
    expect(ruleMatches(pre, bash('npm test'))).toBe(true);
    expect(ruleMatches(pre, bash('npm  test --coverage'))).toBe(true);
    expect(ruleMatches(pre, bash('npm testing'))).toBe(false);
    expect(ruleMatches(pre, bash('npm test; rm -rf ~'))).toBe(false);
    expect(ruleMatches(pre, bash('npm test && curl evil'))).toBe(false);
    expect(ruleMatches(pre, bash('npm test $(id)'))).toBe(false);
    expect(ruleMatches(pre, bash('npm test `id`'))).toBe(false);
    // Other roles and tools are not covered.
    expect(ruleMatches(pre, { ...bash('npm test'), role: 'viewer' })).toBe(false);
    expect(ruleMatches(pre, { tool: 'Write', input: { command: 'npm test' }, role: 'user' })).toBe(false);
    // Tool name variants match (Bash vs bash).
    expect(ruleMatches(pre, { ...bash('npm test'), tool: 'Bash' })).toBe(true);
  });

  it('refuses interpreters, metacharacters and prefixes of other commands', () => {
    expect(code(() => buildRule(bash('bash -c "x"'), 'bash:bash', meta))).toBe('invalid_input');
    expect(code(() => buildRule(bash('sudo ls'), 'bash:sudo', meta))).toBe('invalid_input');
    expect(code(() => buildRule(bash('/usr/bin/env ls'), 'bash:/usr/bin/env', meta))).toBe('invalid_input');
    expect(code(() => buildRule(bash('ls; id'), 'bash:ls;', meta))).toBe('invalid_input');
    expect(code(() => buildRule(bash('git status'), 'bash:git push', meta))).toBe('invalid_input');
    expect(code(() => buildRule(bash('git status'), 'bash:', meta))).toBe('invalid_input');
    // The exact command (even with metacharacters) is allowed: it matches only itself.
    expect(buildRule(bash('ls | wc -l'), 'bash:ls | wc -l', meta)).toMatchObject({ exact: true });
    // A shell tool is never allowed tool-wide.
    expect(code(() => buildRule(bash('ls'), 'bash', meta))).toBe('invalid_input');
    expect(code(() => buildRule({ tool: 'bash', input: {}, role: 'user' }, undefined, meta))).toBe(
      'invalid_input',
    );
  });
});

describe('host rules', () => {
  it('host or a covering *.domain, never broader', () => {
    const r = buildRule(fetchReq('https://registry.npmjs.org/x'), undefined, meta);
    expect(r).toMatchObject({ kind: 'host', value: 'registry.npmjs.org' });
    const wide = buildRule(fetchReq('https://registry.npmjs.org/x'), '*.npmjs.org', meta);
    expect(ruleMatches(wide, fetchReq('https://cdn.npmjs.org/y'))).toBe(true);
    expect(ruleMatches(wide, fetchReq('https://npmjs.org.evil.com/'))).toBe(false);
    expect(code(() => buildRule(fetchReq('https://registry.npmjs.org/'), '*.org', meta))).toBe(
      'invalid_input',
    );
    expect(code(() => buildRule(fetchReq('https://registry.npmjs.org/'), '*', meta))).toBe('invalid_input');
    expect(code(() => buildRule(fetchReq('https://registry.npmjs.org/'), 'evil.com', meta))).toBe(
      'invalid_input',
    );
    expect(code(() => buildRule(fetchReq('http://localhost:3000/'), 'localhost', meta))).toBe(
      'invalid_input',
    );
    // Host rules also widen the sandbox allowlist.
    const a = withRule({ name: 'x', sandbox: { profile: 'workspace' }, approvalRules: [] } as never, wide);
    expect((a.sandbox.policy as { net: { allow: string[] } }).net.allow).toEqual(['*.npmjs.org']);
    expect(withRule(a, wide).approvalRules).toHaveLength(1);
  });
});

describe('path rules', () => {
  const docs = join(homedir(), 'docs', 'notes.md');
  it('exact file or a containing directory; never denied paths, home or root', () => {
    const r = buildRule(write(docs), undefined, meta);
    expect(r).toMatchObject({ kind: 'path', value: docs, exact: true });
    const dir = buildRule(write(docs), '~/docs/', meta);
    expect(dir).toMatchObject({ kind: 'path', value: join(homedir(), 'docs') });
    expect(ruleMatches(dir, write(join(homedir(), 'docs', 'a', 'b.md')))).toBe(true);
    expect(ruleMatches(dir, write(join(homedir(), 'docs2', 'x')))).toBe(false);
    expect(ruleMatches(dir, write(join(homedir(), 'docs', '..', 'x')))).toBe(false);
    expect(code(() => buildRule(write(docs), '~/', meta))).toBe('invalid_input');
    expect(code(() => buildRule(write(docs), '/', meta))).toBe('invalid_input');
    expect(code(() => buildRule(write(docs), '~/other/', meta))).toBe('invalid_input');
    const key = join(homedir(), '.ssh', 'id_ed25519');
    expect(code(() => buildRule(write(key), undefined, meta))).toBe('invalid_input');
    expect(code(() => buildRule(write(key), '~/.ssh/', meta))).toBe('invalid_input');
    // A directory containing a denied path is too broad, and denied files never match.
    const wideHome = { kind: 'path' as const, tool: 'Write', value: homedir(), createdAt: meta.at };
    expect(ruleMatches(wideHome, write(key))).toBe(false);
    expect(code(() => buildRule(write('relative.md'), undefined, meta))).toBe('invalid_input');
  });
});

describe('policy suggestion values', () => {
  it('widens a host to its domain and a path to a parent dir, nothing else', () => {
    expect(suggestionValue('net.allow', 'registry.npmjs.org', '*.npmjs.org')).toBe('*.npmjs.org');
    expect(suggestionValue('net.allow', 'registry.npmjs.org', 'REGISTRY.npmjs.org')).toBe(
      'registry.npmjs.org',
    );
    expect(code(() => suggestionValue('net.allow', 'registry.npmjs.org', '*.org'))).toBe('invalid_input');
    expect(code(() => suggestionValue('net.allow', 'registry.npmjs.org', 'pypi.org'))).toBe('invalid_input');
    const f = join(homedir(), 'data', 'x.csv');
    expect(suggestionValue('fs.read', f, '~/data/')).toBe(join(homedir(), 'data'));
    expect(code(() => suggestionValue('fs.read', f, '~'))).toBe('invalid_input');
    expect(code(() => suggestionValue('fs.read', f, '~/other'))).toBe('invalid_input');
    expect(code(() => suggestionValue('fs.read', join(homedir(), '.aws', 'c'), '~/.aws'))).toBe(
      'invalid_input',
    );
  });
});

describe('misc', () => {
  it('cleans reasons and builds compare URLs without credentials', () => {
    expect(cleanReason('  too\u0007 risky\n ')).toBe('too  risky');
    expect(cleanReason('   ')).toBeUndefined();
    expect(cleanReason('x'.repeat(900))).toHaveLength(500);
    expect(compareUrl('git@github.com:acme/app.git', 'main', 'beamhop/t-1')).toBe(
      'https://github.com/acme/app/compare/main...beamhop%2Ft-1?expand=1',
    );
    expect(compareUrl('https://gitlab.com/acme/app', 'main', 'b')).toContain('/-/merge_requests/new?');
    expect(compareUrl('file:///tmp/x.git', 'main', 'b')).toBeUndefined();
    const pw = ['hunter', '2'].join('');
    expect(stripCredentials(`https://bob:${pw}@github.com/acme/app.git`)).toBe(
      'https://github.com/acme/app.git',
    );
  });
});
