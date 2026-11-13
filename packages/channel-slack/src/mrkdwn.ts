/**
 * Markdown (CommonMark/GFM as written by agents) → Slack `mrkdwn`.
 *
 * Slack reference: https://api.slack.com/reference/surfaces/formatting
 *  - bold `*x*`, italic `_x_`, strike `~x~`, inline code `` `x` ``, code block ```` ```x``` ````
 *  - links `<https://url|text>`; no headings, no tables, no nested lists
 *  - `&`, `<`, `>` MUST be escaped as `&amp;` `&lt;` `&gt;` everywhere (including code),
 *    otherwise Slack parses them as control sequences (`<!channel>`, `<@U123>` …).
 *    Escaping is also what prevents mass mentions: `<!here>`/`<!channel>` can only be
 *    produced via the angle-bracket syntax, which we never emit for user content.
 */

const escapeSlack = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** URLs inside `<url|text>` must not contain `|` or `>`; percent-encode them. */
const escapeUrl = (u: string): string =>
  u.replace(/&/g, '&amp;').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\|/g, '%7C');

/**
 * Bounds for Markdown formatting. The inline passes are regex based and quadratic on a line full
 * of unmatched openers (`**a **a …`), so a hostile or prompt-injected agent could stall the daemon
 * with one large message. Longer lines, or longer messages, are sent unformatted (still escaped).
 */
export const MAX_FORMAT_LINE = 2_000;
export const MAX_FORMAT_TOTAL = 200_000;

const SAFE_SCHEME = /^(https?:|mailto:)/i;

// Private-use sentinels for placeholders (never appear in normal text).
const PH = '';
const BOLD = '';

const convertInline = (text: string): string => {
  const slots: string[] = [];
  const hold = (s: string) => `${PH}${slots.push(s) - 1}${PH}`;

  // Drop our sentinels from the input, so text cannot reference placeholder slots.
  let s = text.replace(/[\uE000\uE001]/g, '');
  // Inline code spans: keep verbatim (escaped).
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code: string) =>
    hold(`\`${escapeSlack(code)}\``),
  );
  // Images ![alt](url) and links [text](url "title")
  s = s.replace(
    /!?\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
    (m, label: string, url: string) => {
      if (!SAFE_SCHEME.test(url)) return hold(escapeSlack(m));
      const t = label.trim();
      return hold(t ? `<${escapeUrl(url)}|${escapeSlack(t).replace(/\|/g, '¦')}>` : `<${escapeUrl(url)}>`);
    },
  );
  // Autolinks <https://…>
  s = s.replace(/<((?:https?:|mailto:)[^>\s]+)>/gi, (_m, url: string) => hold(`<${escapeUrl(url)}>`));

  s = escapeSlack(s);
  // Bold (** or __) → sentinel, so the italic pass doesn't re-match it.
  s = s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, `${BOLD}_$1_${BOLD}`);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, `${BOLD}$1${BOLD}`);
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, `$1${BOLD}$2${BOLD}`);
  // Italic *x* → _x_ (single underscore italics are already Slack italics).
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1_$2_');
  // Strikethrough ~~x~~ → ~x~
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '~$1~');
  s = s.replaceAll(BOLD, '*');
  // Restore placeholders. A link label can hold a code-span placeholder, so repeat until none are
  // left (slots only refer to earlier slots, so this ends after at most slots.length rounds).
  const re = new RegExp(`${PH}(\\d+)${PH}`, 'g');
  for (let round = 0; round <= slots.length && s.includes(PH); round++)
    s = s.replace(re, (_m, i: string) => slots[Number(i)] ?? '');
  return s.replaceAll(PH, '');
};

const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export const markdownToMrkdwn = (md: string): string => {
  if (md.length > MAX_FORMAT_TOTAL) return escapeSlack(md);
  // Our placeholder sentinels never appear in output, not even inside code blocks.
  const lines = md
    .replace(/[\uE000\uE001]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    // Fenced code block: drop the language tag (Slack doesn't highlight), escape content.
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker)) body.push(lines[i++] ?? '');
      i++; // closing fence (or EOF)
      out.push('```', ...body.map(escapeSlack), '```');
      continue;
    }
    // GFM table → monospace block (Slack has no tables).
    if (line.includes('|') && isTableSep(lines[i + 1] ?? '')) {
      const rows: string[] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|')) rows.push(lines[i++] ?? '');
      out.push('```', ...rows.map(escapeSlack), '```');
      continue;
    }
    out.push(convertLine(line));
    i++;
  }
  return out.join('\n');
};

const LINE_RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [
    /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/,
    (m) => {
      const inner = convertInline(m[1] ?? '').replace(/\*/g, '');
      return inner ? `*${inner}*` : '';
    },
  ],
  [/^\s{0,3}([-*_])(\s*\1){2,}\s*$/, () => '──────────'],
  [/^(\s*)>\s?(.*)$/, (m) => `>${convertInline(m[2] ?? '')}`],
  [
    /^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/,
    (m) => `${indent(m[1] ?? '')}${m[2] === ' ' ? '☐' : '☑'} ${convertInline(m[3] ?? '')}`,
  ],
  [/^(\s*)[-*+]\s+(.*)$/, (m) => `${indent(m[1] ?? '')}• ${convertInline(m[2] ?? '')}`],
  [/^(\s*)(\d+)[.)]\s+(.*)$/, (m) => `${indent(m[1] ?? '')}${m[2]}. ${convertInline(m[3] ?? '')}`],
];

const convertLine = (line: string): string => {
  if (line.length > MAX_FORMAT_LINE) return escapeSlack(line);
  for (const [re, fn] of LINE_RULES) {
    const m = re.exec(line);
    if (m) return fn(m);
  }
  return convertInline(line);
};

/** Nested list indentation: Slack collapses leading spaces, so use em-spaces. */
const indent = (ws: string): string => ' '.repeat(Math.floor(ws.replace(/\t/g, '    ').length / 2));

/** Slack-escaped text → plain text for the agent (inbound). */
export const decodeSlackEntities = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
