// Browser-compatible.

/**
 * Render Markdown for Nostr clients (§3.3): plain text, code fences kept verbatim,
 * unsupported inline formatting stripped. Inline `code` is kept since most clients show it fine.
 */
export const renderNostrText = (md: string): string => {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (m && m[1]!.startsWith(fence[0]!) && m[1]!.length >= fence.length && line.trim() === m[1])
        fence = undefined;
      continue;
    }
    if (m) {
      fence = m[1]!;
      out.push(line);
      continue;
    }
    out.push(renderLine(line));
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const renderLine = (line: string): string => {
  let l = line;
  // Horizontal rule
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return '———';
  // Headings
  l = l.replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/, '$1');
  // Bullets
  l = l.replace(
    /^(\s*)[-*+]\s+\[( |x|X)\]\s+/,
    (_, ind: string, c: string) => `${ind}${c === ' ' ? '☐' : '☑'} `,
  );
  l = l.replace(/^(\s*)[-*+]\s+/, '$1• ');
  return renderInline(l);
};

const renderInline = (s: string): string => {
  // Split out inline code spans so we do not touch their contents.
  const parts = s.split(/(`[^`]*`)/);
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return p;
      // Protect backslash escapes from the formatting passes below.
      const escaped: string[] = [];
      let t = p.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_, c: string) => {
        escaped.push(c);
        return `\uE000${escaped.length - 1}\uE001`;
      });
      // Images then links
      t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, _alt: string, url: string) => url);
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, text: string, url: string) =>
        text === url || `mailto:${text}` === url ? url : `${text} (${url})`,
      );
      // Autolinks <https://…>
      t = t.replace(/<((?:https?|nostr|mailto):[^>\s]+)>/g, '$1');
      // Simple HTML tags
      t = t.replace(
        /<\/?(?:b|i|u|em|strong|s|del|br|span|div|p|sup|sub|kbd|mark|small)(?:\s[^>]*)?\/?>/gi,
        '',
      );
      // Bold / italic / strike
      t = t.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2');
      t = t.replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?!\w)/g, '$1$2');
      t = t.replace(/(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1$2');
      t = t.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1');
      return t.replace(/\uE000(\d+)\uE001/g, (_, i: string) => escaped[Number(i)] ?? '');
    })
    .join('');
};
