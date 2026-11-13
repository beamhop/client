import { describe, expect, it } from 'vitest';
import {
  htmlToPlain,
  isBalanced,
  markdownToTelegramHtml as md,
  splitHtml,
  splitPlain,
} from '../src/format.ts';

describe('markdownToTelegramHtml', () => {
  it('escapes <, > and &', () => {
    expect(md('a < b && c > d <script>')).toBe('a &lt; b &amp;&amp; c &gt; d &lt;script&gt;');
  });

  it('renders bold, italic, strike, spoiler', () => {
    expect(md('**bold** and __also__ *it* _em_ ~~gone~~ ||secret||')).toBe(
      '<b>bold</b> and <b>also</b> <i>it</i> <i>em</i> <s>gone</s> <tg-spoiler>secret</tg-spoiler>',
    );
    expect(md('**bold *nested* bold**')).toBe('<b>bold <i>nested</i> bold</b>');
  });

  it('leaves snake_case and lone asterisks alone', () => {
    expect(md('use snake_case_name and 2 * 3 * 4')).toBe('use snake_case_name and 2 * 3 * 4');
  });

  it('renders inline code literally', () => {
    expect(md('run `a <b> **c**` now')).toBe('run <code>a &lt;b&gt; **c**</code> now');
    expect(md('``code with ` tick``')).toBe('<code>code with ` tick</code>');
  });

  it('renders fenced code blocks with language', () => {
    expect(md('```ts\nconst a = 1 < 2;\n**x**\n```\nafter')).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2;\n**x**</code></pre>\nafter',
    );
    expect(md('```\nplain\n```')).toBe('<pre>plain</pre>');
    expect(md('```\nunterminated')).toBe('<pre>unterminated</pre>');
  });

  it('renders safe links and drops unsafe hrefs', () => {
    expect(md('see [the **docs**](https://x.io/a?b=1&c="2")')).toBe(
      'see <a href="https://x.io/a?b=1&amp;c=&quot;2&quot;">the <b>docs</b></a>',
    );
    expect(md('[click](javascript:alert(1))')).toBe('click');
    expect(md('<https://example.com>')).toBe('<a href="https://example.com">https://example.com</a>');
  });

  it('renders headings, lists, quotes, rules, tasks', () => {
    expect(md('# Title\n## Sub *x*')).toBe('<b>Title</b>\n<b>Sub <i>x</i></b>');
    expect(md('- one\n* two\n  + nested\n1. first\n2) second')).toBe(
      '• one\n• two\n  • nested\n1. first\n2. second',
    );
    expect(md('> quoted **a**\n> line 2\nafter')).toBe(
      '<blockquote>quoted <b>a</b>\nline 2</blockquote>\nafter',
    );
    expect(md('---')).toBe('──────────');
    expect(md('- [ ] todo\n- [x] done')).toBe('☐ todo\n☑ done');
  });

  it('always produces balanced HTML (falls back on crossed emphasis)', () => {
    for (const s of ['**a *b** c*', '~~a **b~~ c**', '**x', '[a](https://x) **b', '`unclosed']) {
      expect(isBalanced(md(s))).toBe(true);
    }
  });
});

describe('splitHtml', () => {
  it('returns short input unchanged', () => {
    expect(splitHtml('<b>hi</b>', 100)).toEqual(['<b>hi</b>']);
  });

  it('splits long text at line boundaries within the limit', () => {
    const html = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
    const parts = splitHtml(html, 4096);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join('')).toBe(html);
  });

  it('closes and reopens tags across chunks, never cutting entities', () => {
    const body = `${'a &amp; b '.repeat(60)}`;
    const html = `<pre><code class="language-ts">${body}</code></pre>tail`;
    const parts = splitHtml(html, 200);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(200);
      expect(isBalanced(p)).toBe(true);
      expect(p).not.toMatch(/&[a-z]*$/);
    }
    expect(parts[1]?.startsWith('<pre><code class="language-ts">')).toBe(true);
    expect(parts.map(htmlToPlain).join('')).toBe(htmlToPlain(html));
  });

  it('hard-cuts text without spaces and keeps surrogate pairs intact', () => {
    const html = '😀'.repeat(3000);
    const parts = splitHtml(html, 4096);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(4096);
      expect(p).not.toMatch(/[\uD800-\uDBFF]$/);
    }
    expect(parts.join('')).toBe(html);
  });
});

describe('splitPlain / htmlToPlain', () => {
  it('splits plain text', () => {
    const t = 'word '.repeat(2000);
    const parts = splitPlain(t, 4096);
    expect(parts.join('')).toBe(t);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
  });
  it('strips tags and decodes entities', () => {
    expect(htmlToPlain('<b>a &lt;b&gt; &amp;amp;</b>')).toBe('a <b> &amp;');
  });
});
