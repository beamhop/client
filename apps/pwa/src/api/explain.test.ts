import { describe, expect, it } from 'vitest';
import { explainApproval } from './derive.ts';

const tool = (input: Record<string, unknown>, name = 'bash') =>
  explainApproval({ kind: 'tool', tool: name, input });

describe('explainApproval', () => {
  it('says in one sentence what a request does', () => {
    expect(tool({ command: 'git push origin beamhop/842' })).toBe(
      'Wants to upload code changes to a shared repository.',
    );
    expect(tool({ command: 'rm -rf build' })).toBe('Wants to run a command that deletes files.');
    expect(tool({ command: 'npm install left-pad' })).toBe('Wants to install software on this computer.');
    expect(tool({ command: 'fly deploy --app acme-prod' })).toBe('Wants to change a live service.');
    expect(tool({ command: 'ls -la' })).toBe('Wants to run a command on this computer.');
    expect(tool({ host: 'registry.npmjs.org' }, 'net')).toBe(
      "Wants to reach a website it hasn't been allowed to use yet.",
    );
    expect(tool({ path: '~/docs/a.md' }, 'read')).toBe('Wants to read a file it needs your OK for.');
    expect(tool({ path: '~/docs/a.md' }, 'edit')).toBe('Wants to change a file.');
    expect(explainApproval({ kind: 'access-request', tool: 'talk', input: {} })).toBe(
      'Someone asks to be allowed to talk to this agent.',
    );
    expect(explainApproval({ kind: 'deploy', tool: 'deploy', input: {} })).toMatch(/costs money/);
  });
});
