/**
 * CodeBlock and DiffView (DESIGN §9.3 Code/diff viewer): sunken, `code` type, ink-3 line numbers,
 * added lines go-wash with `+`, removed stop-wash with `−`; horizontal scroll inside the block only
 * (focusable region with a label), wrap toggle, per-file collapse in diffs.
 */
import { CaretRight } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { Button as RACButton } from 'react-aria-components';
import { t } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';
import { CopyButton } from './CliStrip.tsx';

export interface CodeBlockProps {
  code: string;
  /** Region label, e.g. `Tool output: npm test`. */
  label: string;
  lineNumbers?: boolean;
  /** Start wrapped. The toggle is always offered. */
  wrap?: boolean;
  copy?: boolean;
  /** Clamp to N lines with "Show all" (tool output). */
  maxLines?: number;
  className?: string;
}

export const CodeBlock = ({
  code,
  label,
  lineNumbers = false,
  wrap: wrapInit = false,
  copy = true,
  maxLines,
  className,
}: CodeBlockProps) => {
  const [wrap, setWrap] = useState(wrapInit);
  const [all, setAll] = useState(false);
  const lines = code.replace(/\n$/, '').split('\n');
  const shown = maxLines && !all ? lines.slice(0, maxLines) : lines;
  return (
    <div className={cx('overflow-hidden rounded-md bg-sunken', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-line pl-3">
        <span className="truncate type-micro text-ink-3">{label}</span>
        <div className="flex items-center">
          <RACButton
            aria-pressed={wrap}
            onPress={() => setWrap((w) => !w)}
            className="min-h-11 rounded-md px-2 type-meta text-ink-2 data-[hovered]:text-ink aria-pressed:text-ink"
          >
            {t('ui.codeBlock.wrap')}
          </RACButton>
          {copy && <CopyButton value={code} label={t('ui.codeBlock.copyCode')} compact />}
        </div>
      </div>
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="overflow-x-auto py-2 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
      >
        <pre className={cx('type-code text-ink', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
          {shown.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
            <div key={i} className="flex px-3">
              {lineNumbers && (
                <span aria-hidden="true" className="mr-3 w-8 shrink-0 text-right text-ink-3 select-none">
                  {i + 1}
                </span>
              )}
              <span className="min-w-0">{l || ' '}</span>
            </div>
          ))}
        </pre>
      </div>
      {maxLines && lines.length > maxLines && (
        <RACButton
          onPress={() => setAll((a) => !a)}
          className="min-h-11 w-full border-t border-line px-3 text-left type-label text-ink data-[hovered]:bg-[color-mix(in_oklch,var(--bh-sunken),var(--bh-ink)_5%)]"
        >
          {all ? t('ui.codeBlock.showLess') : `Show all ${lines.length} lines`}
        </RACButton>
      )}
    </div>
  );
};

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
  oldNo?: number;
  newNo?: number;
}
interface DiffFile {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

/** Parse a unified diff (git format). Tolerant of missing headers. */
export const parseDiff = (diff: string): DiffFile[] => {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let o = 0;
  let n = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      const m = / b\/(.+)$/.exec(raw);
      cur = { path: m?.[1] ?? raw, added: 0, removed: 0, lines: [] };
      files.push(cur);
      continue;
    }
    if (raw.startsWith('+++ ') || raw.startsWith('--- ') || raw.startsWith('index ')) {
      if (!cur && raw.startsWith('+++ ')) {
        cur = { path: raw.slice(4).replace(/^b\//, ''), added: 0, removed: 0, lines: [] };
        files.push(cur);
      }
      continue;
    }
    if (!cur) {
      cur = { path: 'changes', added: 0, removed: 0, lines: [] };
      files.push(cur);
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      cur.lines.push({ kind: 'hunk', text: raw });
    } else if (raw.startsWith('+')) {
      cur.added++;
      cur.lines.push({ kind: 'add', text: raw.slice(1), newNo: n++ });
    } else if (raw.startsWith('-')) {
      cur.removed++;
      cur.lines.push({ kind: 'del', text: raw.slice(1), oldNo: o++ });
    } else if (raw.length) {
      cur.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: o++, newNo: n++ });
    }
  }
  return files;
};

export const DiffView = ({
  diff,
  className,
  defaultCollapsed = false,
}: {
  diff: string;
  className?: string;
  defaultCollapsed?: boolean;
}) => {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [wrap, setWrap] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>(() =>
    defaultCollapsed ? Object.fromEntries(files.map((f) => [f.path, true])) : {},
  );
  const totals = files.reduce((a, f) => ({ add: a.add + f.added, del: a.del + f.removed }), {
    add: 0,
    del: 0,
  });
  return (
    <div className={cx('overflow-hidden rounded-md border border-line bg-sunken', className)}>
      <div className="flex items-center justify-between border-b border-line pl-3">
        <span className="type-meta text-ink-2">
          {files.length} {files.length === 1 ? 'file' : 'files'} ·{' '}
          <span className="text-go-text">+{totals.add}</span>{' '}
          <span className="text-stop-text">−{totals.del}</span>
        </span>
        <RACButton
          aria-pressed={wrap}
          onPress={() => setWrap((w) => !w)}
          className="min-h-11 px-3 type-meta text-ink-2 data-[hovered]:text-ink aria-pressed:text-ink"
        >
          {t('ui.codeBlock.wrap')}
        </RACButton>
      </div>
      {files.map((f) => {
        const isClosed = closed[f.path];
        return (
          <section key={f.path} className="border-b border-line last:border-b-0">
            <h3 className="m-0">
              <RACButton
                aria-expanded={!isClosed}
                onPress={() => setClosed((c) => ({ ...c, [f.path]: !c[f.path] }))}
                className="flex min-h-11 w-full items-center gap-2 bg-surface px-3 text-left outline-none data-[hovered]:bg-[color-mix(in_oklch,var(--bh-surface),var(--bh-ink)_3%)] data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus"
              >
                <CaretRight
                  size={14}
                  aria-hidden="true"
                  className={cx('shrink-0 text-ink-2', !isClosed && 'rotate-90')}
                />
                <span className="min-w-0 flex-1 truncate type-meta text-ink">{f.path}</span>
                <span className="type-meta text-go-text">+{f.added}</span>
                <span className="type-meta text-stop-text">−{f.removed}</span>
              </RACButton>
            </h3>
            {!isClosed && (
              <div
                role="region"
                aria-label={`Diff of ${f.path}`}
                tabIndex={0}
                className="overflow-x-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
              >
                <table className="w-full border-collapse type-code">
                  <tbody>
                    {f.lines.map((l, i) => (
                      <tr
                        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
                        key={i}
                        className={cx(
                          l.kind === 'add' && 'bg-go-wash',
                          l.kind === 'del' && 'bg-stop-wash',
                          l.kind === 'hunk' && 'text-ink-3',
                        )}
                      >
                        <td
                          aria-hidden="true"
                          className="w-9 pr-2 pl-3 text-right align-top text-ink-3 select-none"
                        >
                          {l.kind === 'del' ? l.oldNo : l.kind === 'hunk' ? '' : l.newNo}
                        </td>
                        <td
                          className={cx(
                            'w-4 align-top select-none',
                            l.kind === 'add'
                              ? 'text-go-text'
                              : l.kind === 'del'
                                ? 'text-stop-text'
                                : 'text-ink-3',
                          )}
                        >
                          <span aria-hidden="true">
                            {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}
                          </span>
                          <span className="sr-only">
                            {l.kind === 'add' ? 'added' : l.kind === 'del' ? 'removed' : ''}
                          </span>
                        </td>
                        <td
                          className={cx(
                            'pr-3 text-ink',
                            wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
                          )}
                        >
                          {l.kind === 'hunk' ? l.text : l.text || ' '}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
};
