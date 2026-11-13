import { DEFAULT_ROLES, type PolicySuggestion, SandboxPolicy } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import {
  acceptSuggestion,
  applyProfile,
  classify,
  describeChanges,
  findingsFor,
  foldersOf,
  hostScopes,
  isWidening,
  parseAllowHost,
  parseEnvName,
  parseFolder,
  toYaml,
  unifiedDiff,
  withFolders,
} from './model.ts';
import { cellFor, ROLE_ACTIONS } from './roles.ts';

const reviewer = (): SandboxPolicy =>
  // structuredClone: zod array defaults (env.passthrough) are shared between parses.
  structuredClone(
    SandboxPolicy.parse({
      fs: { read: ['~/code/app', '~/notes'], write: ['~/code/app'], deny: ['~/.ssh'] },
      net: {
        allow: [
          'api.anthropic.com',
          'github.com',
          '*.githubusercontent.com',
          'objects.githubusercontent.com',
        ],
      },
      secrets: [{ name: 'ANTHROPIC_API_KEY', host: 'api.anthropic.com', header: 'x-api-key' }],
    }),
  );

const sug = (kind: PolicySuggestion['kind'], value: string): PolicySuggestion => ({
  id: `s_${value}`,
  agent: 'helpdesk',
  kind,
  value,
  count: 3,
  lastSeenAt: new Date().toISOString(),
});

describe('folders', () => {
  it('merges read and write lists into one row per path', () => {
    expect(foldersOf(reviewer())).toEqual([
      { path: '~/code/app', mode: 'rw' },
      { path: '~/notes', mode: 'ro' },
    ]);
  });
  it('round-trips through withFolders', () => {
    const p = withFolders(reviewer(), [{ path: '~/notes', mode: 'rw' }]);
    expect(p.fs.read).toEqual(['~/notes']);
    expect(p.fs.write).toEqual(['~/notes']);
    expect(p.fs.deny).toEqual(['~/.ssh']);
  });
});

describe('validation', () => {
  it('extracts a host from a URL and says so', () => {
    expect(parseAllowHost('https://github.com/acme/app')).toEqual({
      value: 'github.com',
      note: 'Added github.com (from https://github.com/acme/app)',
    });
  });
  it('rejects the metadata IP always, private ranges while blocked', () => {
    expect(parseAllowHost('169.254.169.254')).toHaveProperty('error');
    expect(parseAllowHost('169.254.169.254', false)).toHaveProperty('error');
    expect(parseAllowHost('192.168.1.10')).toHaveProperty('error');
    expect(parseAllowHost('192.168.1.10', false)).toEqual({ value: '192.168.1.10' });
  });
  it('rejects garbage and TLD-wide wildcards, accepts explicit wildcards', () => {
    expect(parseAllowHost('htp:/x')).toHaveProperty('error');
    expect(parseAllowHost('*.com')).toHaveProperty('error');
    expect(parseAllowHost('*.npmjs.org')).toEqual({ value: '*.npmjs.org' });
  });
  it('keeps secrets out of env passthrough', () => {
    expect(parseEnvName('NODE_ENV')).toEqual({ value: 'NODE_ENV' });
    expect(parseEnvName('GITHUB_TOKEN')).toHaveProperty('error');
    expect(parseEnvName('1BAD')).toHaveProperty('error');
  });
  it('refuses home and locked folders', () => {
    expect(parseFolder('~')).toHaveProperty('error');
    expect(parseFolder('~/.ssh/keys')).toHaveProperty('error');
    expect(parseFolder('code')).toHaveProperty('error');
    expect(parseFolder('~/code/site/')).toEqual({ value: '~/code/site' });
  });
});

describe('profiles', () => {
  it('strict: nothing writable, network only to broker hosts', () => {
    const p = applyProfile('strict', reviewer());
    expect(p.fs.write).toEqual([]);
    expect(p.net.allow).toEqual(['api.anthropic.com']);
    expect(p.net.denyPrivateIps).toBe(true);
  });
  it('workspace: restores mount modes and adds registries', () => {
    const strict = applyProfile('strict', reviewer());
    const p = applyProfile('workspace', strict, [{ path: '~/code/app', mode: 'rw', parallelUnsafe: false }]);
    expect(p.fs.write).toEqual(['~/code/app']);
    expect(p.net.allow).toContain('registry.npmjs.org');
  });
  it('custom changes nothing', () => {
    expect(applyProfile('custom', reviewer())).toEqual(reviewer());
  });
});

describe('findings', () => {
  it('flags wildcards and offers to keep the exact hosts', () => {
    const f = findingsFor(reviewer()).find((x) => x.id === 'wild:*.githubusercontent.com');
    expect(f?.fix?.label).toBe('Keep only objects.githubusercontent.com');
    const fixed = f?.fix?.apply(reviewer());
    expect(fixed?.net.allow).not.toContain('*.githubusercontent.com');
  });
  it('flags rw folders that are not git, private network, unused keys and secret env', () => {
    const p = reviewer();
    p.net.denyPrivateIps = false;
    p.env.passthrough.push('AWS_SECRET_ACCESS_KEY');
    p.secrets.push({ name: 'FLY_API_TOKEN', host: 'api.fly.io', header: 'Authorization' });
    const ids = findingsFor(p, { gitPaths: new Set() }).map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'lock:~/code/app',
        'private',
        'secret:FLY_API_TOKEN',
        'env:AWS_SECRET_ACCESS_KEY',
      ]),
    );
    expect(findingsFor(p, { gitPaths: new Set(['~/code/app']) }).map((f) => f.id)).not.toContain(
      'lock:~/code/app',
    );
  });
  it('reports nothing for a tidy policy', () => {
    expect(
      findingsFor(structuredClone(SandboxPolicy.parse({ net: { allow: ['api.anthropic.com'] } }))),
    ).toEqual([]);
  });
});

describe('describeChanges', () => {
  it('speaks in plain sentences and separates widening from tightening', () => {
    const base = { profile: 'workspace', policy: reviewer() };
    const next = reviewer();
    next.net.allow.push('registry.npmjs.org');
    next.fs.write = [];
    const cs = describeChanges('reviewer', base, { profile: 'workspace', policy: next });
    expect(cs).toContainEqual({
      kind: 'widen',
      text: 'reviewer will also be able to reach registry.npmjs.org.',
      value: 'registry.npmjs.org',
    });
    expect(cs.find((c) => c.value === '~/code/app')?.kind).toBe('tighten');
    expect(isWidening(cs)).toBe(true);
    expect(isWidening(cs.filter((c) => c.kind !== 'widen'))).toBe(false);
  });
  it('empty when nothing changed', () => {
    expect(
      describeChanges(
        'r',
        { profile: 'strict', policy: reviewer() },
        { profile: 'strict', policy: reviewer() },
      ),
    ).toEqual([]);
  });
});

describe('yaml diff', () => {
  it('produces a unified diff that marks only the changed lines', () => {
    const a = toYaml('workspace', reviewer());
    const p = reviewer();
    p.net.allow.push('pypi.org');
    const d = unifiedDiff('~/.beamhop/agents/reviewer.yaml', a, toYaml('workspace', p));
    expect(d.split('\n').filter((l) => l.startsWith('+'))).toEqual(['+        - pypi.org']);
    expect(d.split('\n').filter((l) => l.startsWith('-'))).toEqual([]);
    expect(d).toContain('diff --git a/~/.beamhop/agents/reviewer.yaml');
    expect(a).toContain('"*.githubusercontent.com"');
  });
});

describe('learning suggestions', () => {
  it('classifies hosts, plain paths, credential files and locked paths', () => {
    expect(classify(sug('net.allow', 'pypi.org'))).toBe('host');
    expect(classify(sug('fs.read', '~/.cache/pip'))).toBe('path');
    expect(classify(sug('fs.read', '~/code/.env'))).toBe('credential');
    expect(classify(sug('fs.read', '~/.ssh/id_ed25519'))).toBe('locked');
  });
  it('offers a wildcard only as a second, explicit scope', () => {
    expect(hostScopes('registry.npmjs.org')).toEqual(['registry.npmjs.org', '*.npmjs.org']);
    expect(hostScopes('pypi.org')).toEqual(['pypi.org']);
  });
  it('accepting adds the chosen value to the draft once', () => {
    const p = acceptSuggestion(reviewer(), sug('net.allow', 'registry.npmjs.org'), '*.npmjs.org');
    expect(p.net.allow.filter((h) => h === '*.npmjs.org')).toHaveLength(1);
    const q = acceptSuggestion(reviewer(), sug('fs.read', '~/.cache/pip'));
    expect(foldersOf(q)).toContainEqual({ path: '~/.cache/pip', mode: 'ro' });
  });
});

describe('roles matrix', () => {
  const role = (n: string) => DEFAULT_ROLES.find((r) => r.name === n)!;
  const action = (id: string) => ROLE_ACTIONS.find((a) => a.id === id)!;
  it('derives Auto/Ask/Deny from the role definition', () => {
    expect(cellFor(role('viewer'), action('bash'))).toBe('deny');
    expect(cellFor(role('user'), action('bash'))).toBe('ask');
    expect(cellFor(role('owner'), action('bash'))).toBe('ask');
    expect(cellFor(role('owner'), action('approve'))).toBe('auto');
    expect(cellFor(role('agent'), action('approve'))).toBe('deny');
    expect(cellFor(role('viewer'), action('read'))).toBe('auto');
  });
});
