/**
 * Chips for domains / paths / env names (DESIGN §9.3): RAC TagGroup. Variants allowed, blocked,
 * suggested (dashed caution), locked (hatched, not removable). Removal is a button inside the chip
 * (never drag). ChipInput accepts a host, `*.domain` or a URL (host extracted, and we say so).
 */
import { Check, LockSimple, Plus, Question, X } from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';
import {
  Input,
  Label,
  Button as RACButton,
  Tag,
  TagGroup,
  TagList,
  Text,
  TextField,
} from 'react-aria-components';
import { cx } from '../lib/cx.ts';
import { descriptionClass, inputShell, labelClass } from './Field.tsx';

export type ChipVariant = 'neutral' | 'allowed' | 'blocked' | 'suggested' | 'locked';

export interface ChipItem {
  id: string;
  label: string;
  variant?: ChipVariant;
  /** Trailing note, e.g. `14×`. */
  note?: string;
}

const VARIANT: Record<ChipVariant, string> = {
  neutral: 'bg-surface border border-line-strong text-ink',
  allowed: 'bg-go-wash text-go-text border border-transparent',
  blocked: 'bg-stop-wash text-stop-text border border-transparent',
  suggested: 'bg-caution-wash text-caution-text border border-dashed border-caution-text',
  locked: 'relative overflow-hidden bg-sunken text-ink-2 border border-line',
};

const ICON: Partial<Record<ChipVariant, ReactNode>> = {
  allowed: <Check size={12} weight="bold" aria-hidden="true" />,
  suggested: <Question size={12} weight="bold" aria-hidden="true" />,
  locked: <LockSimple size={12} weight="bold" aria-hidden="true" />,
};

export interface ChipGroupProps {
  label: string;
  hideLabel?: boolean;
  items: ChipItem[];
  onRemove?: (id: string) => void;
  /** Press a chip (e.g. open triage for a suggestion). */
  onAction?: (id: string) => void;
  className?: string;
  emptyText?: string;
}

export const ChipGroup = ({
  label,
  hideLabel,
  items,
  onRemove,
  onAction,
  className,
  emptyText = 'None',
}: ChipGroupProps) => (
  <TagGroup
    className={cx('flex flex-col gap-1.5', className)}
    onRemove={
      onRemove
        ? (keys) => {
            for (const k of keys) onRemove(String(k));
          }
        : undefined
    }
    onAction={onAction ? (k) => onAction(String(k)) : undefined}
  >
    <Label className={cx('type-micro text-ink-2', hideLabel && 'sr-only')}>{label}</Label>
    <TagList
      items={items}
      className="flex flex-wrap gap-2"
      renderEmptyState={() => <span className="type-meta text-ink-3">{emptyText}</span>}
    >
      {(it) => {
        const v = it.variant ?? 'neutral';
        const removable = !!onRemove && v !== 'locked';
        return (
          <Tag
            id={it.id}
            textValue={it.label}
            className={cx(
              'bh-chip inline-flex h-8 items-center gap-1.5 rounded-sm pl-2 type-meta outline-none',
              'data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus',
              removable ? 'pr-0' : 'pr-2',
              VARIANT[v],
              // 44px hit area via vertical margin compensation in dense chip clouds
              'my-1.5',
            )}
          >
            {v === 'locked' && <span aria-hidden="true" className="hatch absolute inset-0 text-ink-2" />}
            <span className="relative inline-flex items-center gap-1.5">
              {ICON[v]}
              <span>{it.label}</span>
              {it.note && <span>{it.note}</span>}
              {v === 'locked' && <span className="sr-only">(locked, always blocked)</span>}
            </span>
            {removable && (
              <RACButton
                slot="remove"
                aria-label={`Remove ${it.label}`}
                className="relative -my-1.5 grid h-11 w-8 place-items-center rounded-sm opacity-80 data-[hovered]:opacity-100"
              >
                <X size={12} weight="bold" aria-hidden="true" />
              </RACButton>
            )}
          </Tag>
        );
      }}
    </TagList>
  </TagGroup>
);

/** Extract a host from host / *.domain / URL input. Returns [value, note] or an error. */
export const parseHostInput = (raw: string): { value: string; note?: string } | { error: string } => {
  const s = raw.trim().toLowerCase();
  if (!s) return { error: 'Type a host, like github.com.' };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      const u = new URL(s);
      return { value: u.hostname, note: `Added ${u.hostname} (from ${raw.trim()})` };
    } catch {
      return { error: 'That URL could not be read. Try a host, like github.com.' };
    }
  }
  const host = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/;
  const ip = /^\d{1,3}(\.\d{1,3}){3}$/;
  if (host.test(s) || ip.test(s)) return { value: s };
  return { error: `“${raw.trim()}” isn't a host. Use github.com, *.npmjs.org or a URL.` };
};

export interface ChipInputProps extends Omit<ChipGroupProps, 'onAction'> {
  inputLabel?: string;
  placeholder?: string;
  onAdd: (value: string) => void;
  /** Custom validation. Defaults to host parsing. */
  parse?: (raw: string) => { value: string; note?: string } | { error: string };
  description?: ReactNode;
}

export const ChipInput = ({
  inputLabel = 'Add host',
  placeholder = 'Add host, *.domain or URL',
  onAdd,
  parse = parseHostInput,
  description,
  ...group
}: ChipInputProps) => {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const submit = () => {
    const r = parse(value);
    if ('error' in r) {
      setError(r.error);
      return;
    }
    if (group.items.some((i) => i.label === r.value)) {
      setError(`${r.value} is already in the list.`);
      return;
    }
    onAdd(r.value);
    setNote(r.note);
    setError(undefined);
    setValue('');
  };
  return (
    <div className="flex flex-col gap-2">
      <ChipGroup {...group} />
      <TextField
        value={value}
        onChange={(v) => {
          setValue(v);
          setError(undefined);
        }}
        isInvalid={!!error}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        className="flex flex-col gap-1.5"
      >
        <Label className={cx(labelClass, 'sr-only')}>{inputLabel}</Label>
        <div className="relative flex items-center">
          <Input
            placeholder={placeholder}
            className={cx(inputShell, 'h-12 pr-12 pl-3 font-mono')}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <RACButton
            aria-label={inputLabel}
            onPress={submit}
            className="absolute right-0.5 grid size-11 place-items-center rounded-md text-ink data-[hovered]:bg-sunken"
          >
            <Plus size={18} weight="bold" aria-hidden="true" />
          </RACButton>
        </div>
        {description && (
          <Text slot="description" className={descriptionClass}>
            {description}
          </Text>
        )}
        {error && (
          <Text slot="errorMessage" className="type-body-sm text-stop-text">
            {error}
          </Text>
        )}
      </TextField>
      {note && (
        <p className="type-meta text-ink-2" aria-live="polite">
          {note}
        </p>
      )}
    </div>
  );
};
