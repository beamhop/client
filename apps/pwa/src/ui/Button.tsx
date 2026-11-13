/**
 * Buttons (DESIGN §9.1). One primary per view. Allow and Deny differ in shape (fill vs outline), not only hue.
 */
import { forwardRef, type ReactNode } from 'react';
import {
  OverlayArrow,
  Button as RACButton,
  type ButtonProps as RACButtonProps,
  Link as RACLink,
  type LinkProps as RACLinkProps,
  Tooltip,
  TooltipTrigger,
} from 'react-aria-components';
import { cx } from '../lib/cx.ts';
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

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-11 pointer-fine:h-8 px-3 gap-1.5',
  md: 'h-12 pointer-fine:h-10 px-5 gap-2',
  lg: 'h-14 px-6 gap-2 text-base',
};

export const buttonClass = (variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra?: string) =>
  cx(
    'relative inline-flex shrink-0 select-none items-center justify-center rounded-md type-label whitespace-nowrap',
    'transition-[transform,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)] data-[pressed]:scale-[.98]',
    'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[disabled]:saturate-50',
    '[&_svg]:shrink-0',
    VARIANT[variant],
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
 * Pending state: the label is replaced by three animated hop bars, width is locked, `aria-busy` is set
 * (RAC `isPending` keeps the button focusable and announces progress).
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
      ...rest
    },
    ref,
  ) => (
    <RACButton
      ref={ref}
      {...rest}
      isPending={isPending}
      aria-busy={isPending || undefined}
      className={buttonClass(variant, size, cx(fullWidth && 'w-full', className))}
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
  ),
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
    {external && <span className="sr-only"> (opens in a new tab)</span>}
  </RACLink>
);
