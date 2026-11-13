/**
 * Markdown → Discord Markdown.
 *
 * Discord renders most CommonMark natively (https://support.discord.com/hc/en-us/articles/210298617):
 * bold, italics, strike, inline code, fenced code with highlighting, block quotes, lists,
 * masked links `[text](url)` and headings `#`, `##`, `###`. We only adjust what it lacks:
 *  - `####`+ headings → bold line
 *  - GFM tables → monospace code block
 *  - `![alt](url)` images → masked link
 * Mentions are never parsed from our content: every send uses `allowedMentions: { parse: [] }`.
 */

const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export const markdownToDiscord = (md: string): string => {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line.replace(/^(\s*)~~~/, '$1```'));
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (line.includes('|') && isTableSep(lines[i + 1] ?? '')) {
      out.push('```');
      while (i < lines.length && (lines[i] ?? '').includes('|')) out.push(lines[i++] ?? '');
      i--;
      out.push('```');
      continue;
    }
    const h = /^\s{0,3}#{4,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push(`**${h[1] ?? ''}**`);
      continue;
    }
    out.push(
      line.replace(
        /!\[([^\]\n]*)\]\(([^)\s]+)\)/g,
        (_m, alt: string, url: string) => `[${alt || url}](${url})`,
      ),
    );
  }
  return out.join('\n');
};
