/**
 * A deliberately small Markdown subset for agent prose (JOURNEYS §3 "Markdown rendered"): paragraphs,
 * fenced code (→ CodeBlock), bullet/numbered lists, inline `code`, **bold**, and bare https links.
 * No HTML is ever interpreted — agent output is untrusted — so this builds React nodes, never innerHTML.
 */
import { Fragment, type ReactNode } from 'react';
import { t } from '../../i18n/index.ts';
import { TextLink } from '../../ui/Button.tsx';
import { CodeBlock } from '../../ui/CodeBlock.tsx';

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'link'; v: string };

export type ProseBlock =
  | { t: 'p'; inl: Inline[] }
  | { t: 'code'; lang: string; code: string; open: boolean }
  | { t: 'ul' | 'ol'; items: Inline[][] };

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

export const parseInline = (s: string): Inline[] => {
  const out: Inline[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: 'text', v: s.slice(last, i) });
    if (m[1]) out.push({ t: 'code', v: m[1].slice(1, -1) });
    else if (m[2]) out.push({ t: 'bold', v: m[2].slice(2, -2) });
    else if (m[3]) out.push({ t: 'link', v: m[3] });
    last = i + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
};

/** Tolerates an unterminated fence (still streaming): `open: true`. */
export const parseProse = (text: string): ProseBlock[] => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ProseBlock[] = [];
  let para: string[] = [];
  let list: { t: 'ul' | 'ol'; items: Inline[][] } | null = null;
  const flushPara = () => {
    if (para.length) out.push({ t: 'p', inl: parseInline(para.join(' ')) });
    para = [];
  };
  const flushList = () => {
    if (list) out.push(list);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      flushList();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^```\s*$/.test(lines[j]!)) body.push(lines[j++]!);
      out.push({ t: 'code', lang: fence[1] ?? '', code: body.join('\n'), open: j >= lines.length });
      i = j;
      continue;
    }
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (!list || list.t !== kind) {
        flushList();
        list = { t: kind, items: [] };
      }
      list.items.push(parseInline((ul ?? ol)![1]!));
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out;
};

const renderInline = (inl: Inline[]): ReactNode =>
  inl.map((x, i) => {
    switch (x.t) {
      case 'code':
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional inline tokens
          <code key={i} className="rounded-sm bg-sunken px-1 py-px font-mono text-[0.875em] text-ink">
            {x.v}
          </code>
        );
      case 'bold':
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional inline tokens
          <strong key={i} className="font-semibold">
            {x.v}
          </strong>
        );
      case 'link':
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional inline tokens
          <TextLink key={i} href={x.v} external className="break-all">
            {x.v.replace(/^https?:\/\//, '')}
          </TextLink>
        );
      default:
        // biome-ignore lint/suspicious/noArrayIndexKey: positional inline tokens
        return <Fragment key={i}>{x.v}</Fragment>;
    }
  });

const Caret = () => (
  <span aria-hidden="true" className="stream-caret ml-0.5 inline-block text-flare-text">
    ▍
  </span>
);

export const Prose = ({ text, caret }: { text: string; caret?: boolean }) => {
  const blocks = parseProse(text);
  const lastIdx = blocks.length - 1;
  return (
    <div className="flex max-w-[68ch] flex-col gap-2 type-body text-ink [overflow-wrap:anywhere]">
      {blocks.map((b, i) => {
        const end = caret && i === lastIdx;
        if (b.t === 'p')
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: prose blocks are positional
            <p key={i}>
              {renderInline(b.inl)}
              {end && <Caret />}
            </p>
          );
        if (b.t === 'code')
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: prose blocks are positional
            <div key={i}>
              <CodeBlock code={b.code} label={b.lang ? `Code · ${b.lang}` : t('sessions.prose.code')} />
              {end && <Caret />}
            </div>
          );
        const L = b.t;
        return (
          <L
            // biome-ignore lint/suspicious/noArrayIndexKey: prose blocks are positional
            key={i}
            className={
              L === 'ul' ? 'flex list-disc flex-col gap-1 pl-5' : 'flex list-decimal flex-col gap-1 pl-5'
            }
          >
            {b.items.map((it, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional
              <li key={j}>
                {renderInline(it)}
                {end && j === b.items.length - 1 && <Caret />}
              </li>
            ))}
          </L>
        );
      })}
      {caret && blocks.length === 0 && (
        <p>
          <Caret />
        </p>
      )}
    </div>
  );
};
