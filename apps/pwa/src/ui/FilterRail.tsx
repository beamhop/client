/**
 * Single-select filter chips on one horizontal rail (Inbox agents, Sessions agents). Bleeds to the
 * screen edge on compact, fades whichever edge still hides chips (`scroll-rail`), wraps on desktop.
 * Selected = ink fill. Switching is instant (DESIGN §8.1: frequent = no motion).
 */
import { type ReactNode, useRef } from 'react';
import { ToggleButton, ToggleButtonGroup } from 'react-aria-components';
import { cx } from '../lib/cx.ts';
import { useScrollEdges } from '../lib/scroll-edges.ts';

export interface FilterRailOption {
  id: string;
  label: ReactNode;
  count?: number;
  /** Leading mark, e.g. a harness LetterTile. */
  lead?: ReactNode;
  /** Mono label (agent names). */
  mono?: boolean;
}

export const FilterRail = ({
  label,
  options,
  value,
  onChange,
  wrapExpanded = true,
  className,
}: {
  label: string;
  options: FilterRailOption[];
  value: string;
  onChange: (id: string) => void;
  /** Desktop: wrap instead of scrolling. */
  wrapExpanded?: boolean;
  className?: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  useScrollEdges(ref, [options.length, value]);
  return (
    <ToggleButtonGroup
      ref={ref}
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const k = [...keys][0];
        if (k !== undefined) onChange(String(k));
      }}
      className={cx(
        'scroll-rail -mx-gutter flex gap-2 px-gutter py-0.5',
        wrapExpanded && 'expanded:mx-0 expanded:flex-wrap expanded:px-0 expanded:[mask-image:none]',
        className,
      )}
    >
      {options.map((o) => (
        <ToggleButton
          key={o.id}
          id={o.id}
          className={cx(
            'bh-chip inline-flex h-11 shrink-0 items-center gap-2 rounded-md border pr-3 type-label outline-none pointer-fine:h-9',
            o.lead ? 'pl-1.5' : 'pl-3',
            'data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus',
            'border-line-strong bg-surface text-ink data-[hovered]:bg-sunken',
            'data-[selected]:border-ink data-[selected]:bg-ink data-[selected]:text-bg',
          )}
        >
          {o.lead}
          <span className={cx(o.mono && 'font-mono text-[13px]')}>{o.label}</span>
          {o.count !== undefined && <span className="type-meta tabular-nums opacity-75">{o.count}</span>}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
};
