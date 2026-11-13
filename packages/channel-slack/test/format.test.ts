import { describe, expect, it } from 'vitest';
import { decodeSlackEntities, markdownToMrkdwn } from '../src/mrkdwn.ts';
import { splitText } from '../src/split.ts';

describe('markdownToMrkdwn', () => {
  it('converts bold, italics, strike and inline code', () => {
    expect(markdownToMrkdwn('**bold** and *it* and _it2_ and ~~gone~~ and `a*b*c`')).toBe(
      '*bold* and _it_ and _it2_ and ~gone~ and `a*b*c`',
    );
    expect(markdownToMrkdwn('__also bold__')).toBe('*also bold*');
    expect(markdownToMrkdwn('***both***')).toBe('*_both_*');
  });

  it('converts links, autolinks and images; refuses unsafe schemes', () => {
    expect(markdownToMrkdwn('see [the docs](https://example.com/a?b=1&c=2) now')).toBe(
      'see <https://example.com/a?b=1&amp;c=2|the docs> now',
    );
    expect(markdownToMrkdwn('<https://example.com>')).toBe('<https://example.com>');
    expect(markdownToMrkdwn('![chart](https://x.io/c.png)')).toBe('<https://x.io/c.png|chart>');
    expect(markdownToMrkdwn('[a|b](https://x.io/p|q)')).toBe('<https://x.io/p%7Cq|a¦b>');
    expect(markdownToMrkdwn('[click](javascript:alert(1))')).not.toContain('<javascript');
  });

  it('escapes control characters so users cannot inject mass mentions', () => {
    const out = markdownToMrkdwn('ping <!channel> and <!here> and <@U123> & co');
    expect(out).toBe('ping &lt;!channel&gt; and &lt;!here&gt; and &lt;@U123&gt; &amp; co');
    expect(out).not.toMatch(/<!/);
  });

  it('keeps code fences (dropping the language) and escapes inside them', () => {
    const md = 'before\n```ts\nconst a = b < c && **d**;\n```\nafter';
    expect(markdownToMrkdwn(md)).toBe('before\n```\nconst a = b &lt; c &amp;&amp; **d**;\n```\nafter');
  });

  it('renders headings, lists, task lists, quotes and rules', () => {
    const md = [
      '# Title **x**',
      '- one',
      '* two',
      '  - nested',
      '1. first',
      '2) second',
      '- [ ] todo',
      '- [x] done',
      '> quoted *it*',
      '---',
    ].join('\n');
    expect(markdownToMrkdwn(md).split('\n')).toEqual([
      '*Title x*',
      '• one',
      '• two',
      ' • nested',
      '1. first',
      '2. second',
      '☐ todo',
      '☑ done',
      '>quoted _it_',
      '──────────',
    ]);
  });

  it('wraps GFM tables in a monospace block', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\ntext';
    expect(markdownToMrkdwn(md)).toBe('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\ntext');
  });

  it('decodes entities inbound', () => {
    expect(decodeSlackEntities('a &lt;b&gt; &amp;amp;')).toBe('a <b> &amp;');
  });
});

describe('splitText', () => {
  it('returns short text unchanged', () => {
    expect(splitText('hello', 100)).toEqual(['hello']);
  });

  it('splits on line boundaries under the limit', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const parts = splitText(text, 300);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(300);
    expect(parts.join('\n')).toBe(text);
  });

  it('hard-cuts single very long lines', () => {
    const text = 'y'.repeat(1000);
    const parts = splitText(text, 300);
    expect(parts.map((p) => p.length)).toEqual([300, 300, 300, 100]);
    expect(parts.join('')).toBe(text);
  });

  it('closes and reopens code fences across chunks', () => {
    const code = Array.from({ length: 30 }, (_, i) => `console.log(${i}); // ${'z'.repeat(20)}`).join('\n');
    const text = `intro\n\`\`\`js\n${code}\n\`\`\`\noutro`;
    const parts = splitText(text, 400);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(400);
      expect((p.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(parts[1]?.startsWith('```js\n')).toBe(true);
    expect(parts.at(-1)?.endsWith('outro')).toBe(true);
  });

  it('rejects silly limits', () => {
    expect(() => splitText('abc', 4)).toThrow(RangeError);
  });
});
