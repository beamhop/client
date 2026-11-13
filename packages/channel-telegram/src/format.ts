// Markdown → Telegram HTML parse mode (§3.3), plus a tag-aware splitter.
// Supported Telegram tags: b, i, s, u, code, pre, a, blockquote, tg-spoiler.

export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, '&quot;');

const SAFE_HREF = /^(https?:\/\/|tg:\/\/|mailto:)/i;
const PH = '\uE000';

/** Render inline Markdown (code, links, bold, italic, strike) as Telegram HTML. */
const renderInline = (src: string, allowLinks = true): string => {
  const slots: string[] = [];
  const hold = (html: string) => `${PH}${slots.push(html) - 1}${PH}`;
  let s = src.replace(/\uE000/g, '');
  // Code spans first: their contents are literal.
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks, code: string) => {
    const inner = code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code;
    return hold(`<code>${escapeHtml(inner)}</code>`);
  });
  if (allowLinks) {
    s = s.replace(
      /\[([^\]\n]+)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/g,
      (_m, text: string, href: string) => {
        const inner = renderInline(text, false);
        return hold(SAFE_HREF.test(href) ? `<a href="${escapeAttr(href)}">${inner}</a>` : inner);
      },
    );
    s = s.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, (_m, href: string) =>
      hold(`<a href="${escapeAttr(href)}">${escapeHtml(href)}</a>`),
    );
  }
  s = escapeHtml(s);
  s = s.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<b>$1</b>');
  s = s.replace(/(?<![\w_])__(?=\S)([\s\S]+?)(?<=\S)__(?![\w_])/g, '<b>$1</b>');
  s = s.replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<s>$1</s>');
  s = s.replace(/\|\|(?=\S)([\s\S]+?)(?<=\S)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');
  s = s.replace(/(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/g, '<i>$1</i>');
  s = s.replace(/(?<![\w_])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w_])/g, '<i>$1</i>');
  return s.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => slots[Number(i)] ?? '');
};

/** True when every tag is closed in the right order. */
export const isBalanced = (html: string): boolean => {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    const [, close, name] = m;
    if (!name) continue;
    if (close) {
      if (stack.pop() !== name) return false;
    } else stack.push(name);
  }
  return stack.length === 0;
};

/** Convert agent Markdown to Telegram HTML. Output is always tag-balanced. */
export const markdownToTelegramHtml = (md: string): string => {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker)) body.push(lines[i++] ?? '');
      i++; // closing fence (or EOF)
      const code = escapeHtml(body.join('\n'));
      out.push(
        lang ? `<pre><code class="language-${escapeAttr(lang)}">${code}</code></pre>` : `<pre>${code}</pre>`,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) {
        quoted.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${quoted.map((q) => renderBlockLine(q)).join('\n')}</blockquote>`);
      continue;
    }
    out.push(renderBlockLine(line));
    i++;
  }
  const html = out.join('\n');
  if (isBalanced(html)) return html;
  // Pathological nesting (e.g. crossed emphasis): fall back to escaped text.
  return escapeHtml(md);
};

const renderBlockLine = (line: string): string => {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) return `<b>${renderInline(heading[1] ?? '')}</b>`;
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return '──────────';
  const task = /^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
  if (task) return `${task[1]}${task[2] === ' ' ? '☐' : '☑'} ${renderInline(task[3] ?? '')}`;
  const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (ul) return `${ul[1]}• ${renderInline(ul[2] ?? '')}`;
  const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (ol) return `${ol[1]}${ol[2]}. ${renderInline(ol[3] ?? '')}`;
  return renderInline(line);
};

/** Strip tags and decode entities: the plain-text fallback for an HTML chunk. */
export const htmlToPlain = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * Split Telegram HTML into chunks of at most `limit` characters, never cutting inside a tag or
 * entity; tags open at a split are closed at the end of one chunk and reopened in the next.
 */
export const splitHtml = (html: string, limit = TELEGRAM_TEXT_LIMIT): string[] => {
  if (html.length <= limit) return [html];
  const tokens = html.match(/<[^>]*>|&[#a-zA-Z0-9]+;|[^<&]+|[<&]/g) ?? [];
  const chunks: string[] = [];
  const stack: { name: string; open: string }[] = [];
  const closing = () =>
    stack
      .slice()
      .reverse()
      .map((t) => `</${t.name}>`)
      .join('');
  const reopen = () => stack.map((t) => t.open).join('');
  let cur = '';
  let hasContent = false;
  const flush = () => {
    if (hasContent) chunks.push(cur + closing());
    cur = reopen();
    hasContent = false;
  };
  for (const tok of tokens) {
    if (tok.startsWith('<') && tok.endsWith('>') && tok.length > 1) {
      const m = /^<(\/?)([a-z-]+)/.exec(tok);
      const isClose = m?.[1] === '/';
      const name = m?.[2] ?? '';
      // Opening tag also needs room for its own closing tag.
      const need = tok.length + (isClose ? 0 : name.length + 3);
      if (cur.length + need + closing().length > limit) flush();
      cur += tok;
      if (isClose) stack.pop();
      else stack.push({ name, open: tok });
      continue;
    }
    if (tok.startsWith('&') && tok.endsWith(';')) {
      if (cur.length + tok.length + closing().length > limit) flush();
      cur += tok;
      hasContent = true;
      continue;
    }
    let text = tok;
    while (text.length > 0) {
      const room = limit - cur.length - closing().length;
      if (text.length <= room) {
        cur += text;
        hasContent = true;
        break;
      }
      if (room <= 0) {
        flush();
        continue;
      }
      let cut = room;
      const nl = text.lastIndexOf('\n', room);
      const sp = text.lastIndexOf(' ', room);
      if (nl > room / 2) cut = nl + 1;
      else if (sp > room / 2) cut = sp + 1;
      const code = text.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--; // don't split a surrogate pair
      if (cut <= 0) {
        flush();
        continue;
      }
      cur += text.slice(0, cut);
      hasContent = true;
      text = text.slice(cut);
      flush();
    }
  }
  if (hasContent) chunks.push(cur + closing());
  return chunks;
};

/** Split plain text into chunks of at most `limit` characters, preferring line/word boundaries. */
export const splitPlain = (text: string, limit = TELEGRAM_TEXT_LIMIT): string[] => {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    const nl = rest.lastIndexOf('\n', limit);
    const sp = rest.lastIndexOf(' ', limit);
    if (nl > limit / 2) cut = nl + 1;
    else if (sp > limit / 2) cut = sp + 1;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0 || out.length === 0) out.push(rest);
  return out;
};
