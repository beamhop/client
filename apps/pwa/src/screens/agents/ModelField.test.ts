import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, modelOptions } from './ModelField.tsx';

describe('modelOptions', () => {
  it('puts the harness default first, then the listed models, then a custom id', () => {
    const opts = modelOptions([
      { id: 'gpt-a', label: 'GPT-A', description: 'fast', isDefault: true },
      { id: 'gpt-b' },
    ]);
    expect(opts.map((o) => o.id)).toEqual([DEFAULT_MODEL, 'gpt-a', 'gpt-b', '__custom']);
    // The default row names what the harness would pick.
    expect(opts[0]?.description).toContain('GPT-A');
    expect(opts[1]).toMatchObject({ label: 'GPT-A (gpt-a)', description: 'fast' });
    expect(opts[2]).toMatchObject({ label: 'gpt-b' });
  });

  it('does not repeat a harness row that is itself called "default"', () => {
    const opts = modelOptions([
      { id: 'default', label: 'Default (recommended)', isDefault: true },
      { id: 'sonnet', label: 'Sonnet' },
    ]);
    expect(opts.map((o) => o.id)).toEqual([DEFAULT_MODEL, 'sonnet', '__custom']);
    expect(opts[0]?.description).toBeUndefined();
  });
});
