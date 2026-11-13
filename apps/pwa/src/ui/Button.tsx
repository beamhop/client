/**
 * Buttons (DESIGN §9.1). One primary per view. Allow and Deny differ in shape (fill vs outline), not only hue.
 */
import { forwardRef, type ReactNode, useEffect, useRef } from 'react';
import {
  OverlayArrow,
  Button as RACButton,
  type ButtonProps as RACButtonProps,
  Link as RACLink,
  type LinkProps as RACLinkProps,
  Tooltip,
  TooltipTrigger,
} from 'react-aria-components';
import { t } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';
import { announce } from '../lib/live.ts';
import { useExpanded } from '../lib/media.ts';
import { HopMeter } from './glyphs/index.tsx';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'quiet'
  | 'allow'
  | 'deny'
  | 'destructive'
  | 'destructive-outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-flare text-on-flare data-[hovered]:bg-[color-mix(in_oklch,var(--bh-flare),var(--bh-ink)_6%)] data-[pressed]:bg-[color-mix(in_oklch,var(--bh-flare),var(--bh-ink)_12%)]',
  secondary:
    'bg-surface text-ink border border-line-strong data-[hovered]:bg-sunken data-[pressed]:bg-[color-mix(in_oklch,var(--bh-sunken),var(--bh-ink)_6%)]',
  quiet:
    'bg-transparent text-ink px-3! data-[hovered]:underline underline-offset-[3px] data-[pressed]:bg-sunken',
  allow:
    'bg-go text-on-go data-[hovered]:bg-[color-mix(in_oklch,var(--bh-go),var(--bh-ink)_8%)] data-[pressed]:bg-[color-mix(in_oklch,var(--bh-go),var(--bh-ink)_14%)]',
  deny: 'bg-surface text-stop-text border-[1.5px] border-stop-text data-[hovered]:bg-stop-wash data-[pressed]:bg-stop-wash',
  destructive:
    'bg-stop text-on-stop data-[hovered]:bg-[color-mix(in_oklch,var(--bh-stop),var(--bh-ink)_8%)] data-[pressed]:bg-[color-mix(in_oklch,var(--bh-stop),var(--bh-ink)_14%)]',
  'destructive-outline':
    'bg-transparent text-stop-text border border-stop-text data-[hovered]:bg-stop-wash data-[pressed]:bg-stop-wash',
};

const FILLED: ReadonlySet<ButtonVariant> = new Set(['primary', 'allow', 'destructive']);

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-11 pointer-fine:h-8 px-3 gap-1.5',
  md: 'h-12 pointer-fine:h-10 px-5 gap-2',
  lg: 'h-14 px-6 gap-2 text-base',
};

export const buttonClass = (variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra?: string) =>
  cx(
    'relative inline-flex shrink-0 select-none items-center justify-center rounded-md type-label whitespace-nowrap',
    'transition-[transform,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)] data-[pressed]:scale-[.98]',
    'data-[disabled]:cursor-not-allowed',
    '[&_svg]:shrink-0',
    VARIANT[variant],
    // Filled buttons don't fade when disabled (a 45% flare reads as broken): they become an empty,
    // dashed slot in ink-3 — "not armed yet" — and fill once the form is ready.
    FILLED.has(variant)
      ? 'data-[disabled]:border data-[disabled]:border-dashed data-[disabled]:border-line-strong data-[disabled]:bg-sunken data-[disabled]:text-ink-3'
      : 'data-[disabled]:opacity-45 data-[disabled]:saturate-50',
    SIZE[size],
    extra,
  );

export interface ButtonProps extends Omit<RACButtonProps, 'className' | 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (Phosphor element). */
  icon?: ReactNode;
  /** Trailing content, e.g. a `<Kbd>` hint on desktop. */
  trailing?: ReactNode;
  fullWidth?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * Pending state: the label is replaced by three animated hop bars, width is locked, `aria-busy` and
 * `aria-disabled` are set and presses are ignored, but the button stays focusable.
 * We do not use RAC's `isPending`: it announces through a `role="img"` node labelled by the button's
 * id, which dangles (axe: role-img-alt) once the button unmounts — e.g. a sheet that closes on success.
 * Progress is announced as plain text in our own polite live region instead.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'secondary',
      size = 'md',
      icon,
      trailing,
      fullWidth,
      className,
      children,
      isPending,
      onPress,
      onPressStart,
      onPressEnd,
      onPressChange,
      onPressUp,
      ...rest
    },
    ref,
  ) => {
    const own = useRef<HTMLButtonElement | null>(null);
    const was = useRef(!!isPending);
    useEffect(() => {
      const el = own.current;
      if (was.current !== !!isPending && el && document.activeElement === el) {
        const name = el.getAttribute('aria-label') || el.textContent?.trim() || '';
        announce(isPending ? t('a11y.busy', { name }) : t('a11y.done', { name }));
      }
      was.current = !!isPending;
    }, [isPending]);
    const press = isPending ? {} : { onPress, onPressStart, onPressEnd, onPressChange, onPressUp };
    return (
      <RACButton
        ref={(el) => {
          own.current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) ref.current = el;
        }}
        {...rest}
        {...press}
        aria-busy={isPending || undefined}
        aria-disabled={isPending || rest['aria-disabled'] || undefined}
        data-pending={isPending || undefined}
        type={rest.type === 'submit' && isPending ? 'button' : rest.type}
        className={buttonClass(
          variant,
          size,
          cx(fullWidth && 'w-full', 'data-[pending]:cursor-wait', className),
        )}
      >
        <span className={cx('inline-flex items-center gap-[inherit]', isPending && 'opacity-0')}>
          {icon}
          {children}
          {trailing}
        </span>
        {isPending && (
          <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
            <HopMeter up={3} total={3} busy tone="ink" className="text-current [&>span]:bg-current!" />
          </span>
        )}
      </RACButton>
    );
  },
);
Button.displayName = 'Button';

export interface IconButtonProps extends Omit<RACButtonProps, 'className' | 'children'> {
  /** Mandatory accessible name; also the desktop tooltip. */
  label: string;
  icon: ReactNode;
  variant?: 'ghost' | 'secondary' | 'destructive' | 'destructive-ghost';
  /** Show tooltip on hover/focus (desktop). Default true. */
  tooltip?: boolean;
  shortcut?: string;
  className?: string;
}

/** 44×44 hit area regardless of glyph size; tooltip after 600 ms. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, icon, variant = 'ghost', tooltip = true, shortcut, className, ...rest }, ref) => {
    const btn = (
      <RACButton
        ref={ref}
        aria-label={label}
        {...rest}
        className={cx(
          'inline-grid size-11 shrink-0 place-items-center rounded-md text-ink transition-colors duration-[var(--dur-fast)]',
          'data-[disabled]:opacity-45',
          variant === 'ghost' && 'data-[hovered]:bg-sunken data-[pressed]:bg-sunken',
          variant === 'secondary' && 'border border-line-strong bg-surface data-[hovered]:bg-sunken',
          variant === 'destructive' &&
            'bg-stop text-on-stop data-[pressed]:bg-[color-mix(in_oklch,var(--bh-stop),var(--bh-ink)_14%)]',
          variant === 'destructive-ghost' &&
            'text-stop-text data-[hovered]:bg-stop-wash data-[pressed]:bg-stop-wash',
          className,
        )}
      >
        {icon}
      </RACButton>
    );
    if (!tooltip) return btn;
    return (
      <TooltipTrigger delay={600} closeDelay={0}>
        {btn}
        <Tooltip
          offset={6}
          className="z-[70] rounded-sm bg-ink px-2 py-1 type-meta text-bg shadow-pop data-[entering]:animate-none"
        >
          <OverlayArrow>
            <svg width={8} height={8} viewBox="0 0 8 8" className="fill-ink" aria-hidden="true">
              <path d="M0 0 L4 4 L8 0" />
            </svg>
          </OverlayArrow>
          {label}
          {shortcut && <span className="ml-2 opacity-70">{shortcut}</span>}
        </Tooltip>
      </TooltipTrigger>
    );
  },
);
IconButton.displayName = 'IconButton';

export interface LinkButtonProps extends Omit<RACLinkProps, 'className' | 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  fullWidth?: boolean;
  className?: string;
  children?: ReactNode;
}

/** A navigation that looks like a button (e.g. `+ New agent`). Uses the router via RAC RouterProvider. */
export const LinkButton = ({
  variant = 'secondary',
  size = 'md',
  icon,
  fullWidth,
  className,
  children,
  ...rest
}: LinkButtonProps) => (
  <RACLink
    {...rest}
    className={buttonClass(variant, size, cx(fullWidth && 'w-full', 'no-underline', className))}
  >
    {icon}
    {children}
  </RACLink>
);

export interface BarActionProps {
  /** Visible label on desktop; accessible name + tooltip on compact. */
  label: string;
  /** Full-label override for the accessible name (e.g. "Add a channel"). */
  ariaLabel?: string;
  /** Glyph at 20px (compact) — the desktop button reuses it at 16px via CSS. */
  icon: ReactNode;
  href?: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary';
  isPending?: boolean;
  isDisabled?: boolean;
}

/**
 * The one screen-level action in a top bar ("New agent", "Add", "Scan"). Expanded: a labelled button
 * in the pane header. Compact: a 44px icon button so the bar never holds more than pill · action · Stop
 * (the label stays the accessible name). Same shape on every list screen.
 */
export const BarAction = ({
  label,
  ariaLabel,
  icon,
  href,
  onPress,
  variant = 'primary',
  isPending,
  isDisabled,
}: BarActionProps) => {
  const expanded = useExpanded();
  if (expanded) {
    const iconSm = <span className="inline-grid [&_svg]:size-4">{icon}</span>;
    return href ? (
      <LinkButton href={href} variant={variant} size="sm" icon={iconSm} aria-label={ariaLabel}>
        {label}
      </LinkButton>
    ) : (
      <Button
        variant={variant}
        size="sm"
        icon={iconSm}
        aria-label={ariaLabel}
        onPress={onPress}
        isPending={isPending}
        isDisabled={isDisabled}
      >
        {label}
      </Button>
    );
  }
  const name = ariaLabel ?? label;
  const cls = cx(
    'inline-grid size-11 shrink-0 place-items-center rounded-md text-ink outline-none transition-colors duration-[var(--dur-fast)]',
    'data-[hovered]:bg-sunken data-[pressed]:bg-sunken data-[disabled]:opacity-45',
    'data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-focus',
  );
  return href ? (
    <RACLink href={href} aria-label={name} className={cls}>
      {icon}
    </RACLink>
  ) : (
    <IconButton
      label={isPending ? t('a11y.busy', { name }) : name}
      icon={icon}
      onPress={onPress}
      isDisabled={isDisabled || isPending}
    />
  );
};

/** Inline text link (DESIGN §9.1). External links get ↗ and open in a new tab. */
export const TextLink = ({
  children,
  className,
  external,
  ...rest
}: RACLinkProps & { external?: boolean; className?: string; children?: ReactNode }) => (
  <RACLink
    {...rest}
    target={external ? '_blank' : rest.target}
    rel={external ? 'noopener noreferrer' : rest.rel}
    className={cx(
      'text-ink underline decoration-1 underline-offset-[3px] data-[hovered]:decoration-2',
      className,
    )}
  >
    {children}
    {external && (
      <span aria-hidden="true" className="ml-0.5 inline-block font-mono text-[0.8em]">
        ↗
      </span>
    )}
    {external && <span className="sr-only"> {t('ui.button.opensInANew')}</span>}
  </RACLink>
);
