/**
 * Small building blocks shared by the Settings sections: grouped list, row, section header,
 * a row overflow menu, and `useLocalPref` for per-device preferences.
 */
import { DotsThree } from '@phosphor-icons/react';
import { type ReactNode, useSyncExternalStore } from 'react';
import { Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { cx } from '../../lib/cx.ts';
import { IconButton } from '../../ui/Button.tsx';
import { TextField } from '../../ui/Field.tsx';
import { Eyebrow } from '../../ui/Meta.tsx';

export const Group = ({
  title,
  id,
  action,
  children,
  note,
  className,
}: {
  title: string;
  id: string;
  action?: ReactNode;
  children: ReactNode;
  note?: ReactNode;
  className?: string;
}) => (
  <section aria-labelledby={id} className={cx('flex flex-col gap-1', className)}>
    <Eyebrow id={id} action={action}>
      {title}
    </Eyebrow>
    {children}
    {note && <p className="mt-1 type-body-sm text-ink-2">{note}</p>}
  </section>
);

/** Hairline list group: surface, 1px line, radius-lg, rows divided by hairlines. */
export const List = ({ children, label }: { children: ReactNode; label?: string }) => (
  <ul
    aria-label={label}
    className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface"
  >
    {children}
  </ul>
);

export const Row = ({
  leading,
  title,
  slug,
  aside,
  actions,
  hatched,
  className,
}: {
  leading?: ReactNode;
  title: ReactNode;
  slug?: ReactNode;
  aside?: ReactNode;
  actions?: ReactNode;
  hatched?: boolean;
  className?: string;
}) => (
  <li className={cx('relative flex min-h-14 items-center gap-3 py-2.5 pr-1.5 pl-4', className)}>
    {hatched && <span aria-hidden="true" className="hatch pointer-events-none absolute inset-0 text-ink-3" />}
    {leading && <span className="relative shrink-0 text-ink-2">{leading}</span>}
    <span className="relative flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate type-title-3 text-ink">{title}</span>
        {aside}
      </span>
      {slug}
    </span>
    {actions && <span className="relative flex shrink-0 items-center">{actions}</span>}
  </li>
);

export interface RowMenuItem {
  id: string;
  label: string;
  destructive?: boolean;
  onAction: () => void;
}

/** `⋯` overflow for a row (DESIGN §9.2 Popover/Menu: items 44px min, level-2 elevation). */
export const RowMenu = ({ label, items }: { label: string; items: RowMenuItem[] }) => (
  <MenuTrigger>
    <IconButton label={label} icon={<DotsThree size={22} weight="bold" />} tooltip={false} />
    <Popover
      placement="bottom end"
      className="min-w-44 rounded-lg border border-line bg-surface p-1 shadow-pop outline-none"
    >
      <Menu
        aria-label={label}
        className="outline-none"
        onAction={(k) => items.find((i) => i.id === k)?.onAction()}
      >
        {items.map((i) => (
          <MenuItem
            key={i.id}
            id={i.id}
            className={cx(
              'flex min-h-11 cursor-default items-center rounded-md px-3 type-label outline-none data-[focused]:bg-sunken',
              i.destructive ? 'text-stop-text' : 'text-ink',
            )}
          >
            {i.label}
          </MenuItem>
        ))}
      </Menu>
    </Popover>
  </MenuTrigger>
);

// ─────────── per-device preferences (localStorage, never secrets) ───────────
const listeners = new Set<() => void>();
const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
};
const cache = new Map<string, { raw: string | null; value: unknown }>();

/**
 * A small object persisted in localStorage for this device. Used for settings the daemon API doesn't
 * expose yet (each use is marked TODO(core) with the CLI equivalent shown next to it).
 */
export const useLocalPref = <T extends Record<string, unknown>>(key: string, fallback: T) => {
  const value = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(key);
      } catch {
        /* ignore */
      }
      const hit = cache.get(key);
      if (hit && hit.raw === raw) return hit.value as T;
      const v = read(key, fallback);
      cache.set(key, { raw, value: v });
      return v;
    },
    () => fallback,
  );
  const set = (patch: Partial<T>) => {
    try {
      localStorage.setItem(key, JSON.stringify({ ...value, ...patch }));
    } catch {
      /* ignore */
    }
    for (const l of listeners) l();
  };
  return [value, set] as const;
};

// ─────────── type-to-confirm (irreversible, costly actions) ───────────
/**
 * Typing the exact name is the accessible, deliberate friction for irreversible actions (JOURNEYS §7
 * Destroy; GitHub's "type the repository name" pattern). Case-sensitive, trimmed, paste allowed.
 */
export const confirmMatches = (typed: string, expected: string) => typed.trim() === expected;

export const TypeToConfirm = ({
  expected,
  value,
  onChange,
  label,
}: {
  expected: string;
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) => (
  <TextField
    label={label ?? `Type ${expected} to confirm`}
    mono
    value={value}
    onChange={onChange}
    autoComplete="off"
    spellCheck="false"
    placeholder={expected}
    description={
      value && !confirmMatches(value, expected)
        ? `Doesn't match "${expected}" yet.`
        : 'Exact spelling, case-sensitive.'
    }
  />
);
