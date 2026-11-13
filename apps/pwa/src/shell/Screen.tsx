/**
 * <Screen> — the frame every screen renders into (README § Adding a screen).
 *
 * Compact: sticky 52px top bar (+ safe area) with back or title, connection pill, actions and the
 * Stop button on top-level screens; a large title (title-1) that collapses into the bar after scroll;
 * panic band + banners right under the bar.
 * Expanded: a pane header (title, breadcrumbs, actions) inside a scrolling pane; global banners live
 * in the shell's status strip instead.
 */
import { CaretLeft } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-aria-components';
import { cx } from '../lib/cx.ts';
import { useExpanded } from '../lib/media.ts';
import { ConnectionPill } from './Connection.tsx';
import { PanicButton } from './panic.tsx';
import { ShellBanners } from './ShellBanners.tsx';

export interface Crumb {
  label: string;
  href?: string;
}

export interface ScreenProps {
  title: string;
  /** Back target on compact (secondary screens). Omit on top-level screens. */
  back?: { href: string; label?: string };
  /** Right side of the bar (1–2 IconButtons max on compact). */
  actions?: ReactNode;
  /** Mono slug line under the large title. */
  slug?: ReactNode;
  /** Right-aligned element next to the large title (e.g. a Doto readout `03 PENDING`). */
  titleAside?: ReactNode;
  /** Desktop breadcrumbs for detail panes: Agents / reviewer / Sandbox. */
  crumbs?: Crumb[];
  /** `list` and `detail` are panes inside <SplitView>; `single` fills the main area. */
  pane?: 'single' | 'list' | 'detail';
  /** Show the Stop button in the compact bar (default: top-level screens). */
  showPanic?: boolean;
  /** Max content width on desktop single panes (DESIGN: 960 general, 640 forms). */
  maxWidth?: 'prose' | 'form' | 'wide' | 'none';
  /** Remove the default gutter/padding (full-bleed content such as a transcript). */
  bleed?: boolean;
  children: ReactNode;
  /** Sticky bottom region (composer, save bar). */
  footer?: ReactNode;
  className?: string;
}

const MAX = { prose: 'max-w-[760px]', form: 'max-w-[640px]', wide: 'max-w-[960px]', none: '' };

export const Screen = ({ title, back, actions, slug, titleAside, crumbs, pane = 'single', showPanic, maxWidth = 'wide', bleed, children, footer, className }: ScreenProps) => {
  const expanded = useExpanded();
  const topLevel = !back;
  const largeTitle = topLevel && !expanded;
  const sentinel = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(!largeTitle);

  useEffect(() => {
    if (!largeTitle) {
      setCollapsed(true);
      return;
    }
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setCollapsed(!e?.isIntersecting), { rootMargin: '-52px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [largeTitle]);

  const panicVisible = showPanic ?? topLevel;

  if (!expanded) {
    return (
      <div className={cx('flex min-h-dvh flex-col', className)} data-screen={title}>
        <header className="sticky top-0 z-30 border-b border-transparent bg-bg pt-safe data-[collapsed=true]:border-line" data-collapsed={collapsed}>
          <div className="flex h-[52px] items-center gap-1 pr-1 pl-1">
            {back ? (
              <Link
                href={back.href}
                aria-label={back.label ? `Back to ${back.label}` : 'Back'}
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-ink outline-none data-[hovered]:bg-sunken data-[pressed]:bg-sunken"
              >
                <CaretLeft size={22} aria-hidden="true" />
              </Link>
            ) : (
              <span className="w-3" />
            )}
            <p
              aria-hidden={largeTitle ? 'true' : undefined}
              className={cx(
                'min-w-0 flex-1 truncate text-ink transition-opacity duration-[var(--dur-fast)]',
                back ? 'type-title-3' : 'type-title-2',
                largeTitle && !collapsed && 'opacity-0',
              )}
            >
              {title}
            </p>
            <ConnectionPill />
            {actions}
            {panicVisible && <PanicButton />}
          </div>
        </header>
        <ShellBanners />
        {largeTitle && (
          <div className="px-gutter pt-1 pb-3">
            <div className="flex items-end justify-between gap-3">
              <h1 className="type-title-1 text-ink">{title}</h1>
              {titleAside}
            </div>
            {slug && <div className="mt-0.5">{slug}</div>}
            <div ref={sentinel} aria-hidden="true" className="h-px" />
          </div>
        )}
        {!largeTitle && <h1 className="sr-only">{title}</h1>}
        {!largeTitle && (slug || titleAside) && (
          <div className="flex items-center justify-between gap-3 px-gutter pt-2">
            <div className="min-w-0">{slug}</div>
            {titleAside}
          </div>
        )}
        <div id="bh-main-content" className={cx('flex-1', !bleed && 'px-gutter pt-2 pb-[calc(var(--bh-tabbar-h)+var(--bh-safe-bottom)+24px)]')}>
          {children}
        </div>
        {footer && <div className="sticky bottom-0 z-20 border-t border-line bg-bg pb-safe">{footer}</div>}
      </div>
    );
  }

  return (
    <div className={cx('flex h-full min-h-0 flex-col', className)} data-screen={title}>
      <div data-scroll-root="" className="pane-scroll min-h-0 flex-1">
        <header className={cx('sticky top-0 z-20 bg-bg', pane === 'list' ? 'border-b border-line px-5' : 'px-8')}>
          {crumbs && crumbs.length > 0 && (
            <nav aria-label="Breadcrumb" className="pt-4 type-meta text-ink-2">
              <ol className="flex flex-wrap items-center gap-1.5">
                {crumbs.map((c, i) => (
                  <li key={`${c.label}-${i}`} className="flex items-center gap-1.5">
                    {i > 0 && <span aria-hidden="true">/</span>}
                    {c.href ? (
                      <Link href={c.href} className="text-ink-2 underline-offset-[3px] outline-none data-[hovered]:text-ink data-[hovered]:underline">
                        {c.label}
                      </Link>
                    ) : (
                      <span aria-current="page" className="text-ink">
                        {c.label}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          )}
          <div className={cx('flex items-center gap-3', pane === 'list' ? 'min-h-16' : 'min-h-[72px]')}>
            <h1 className={cx('min-w-0 flex-1 truncate text-ink', pane === 'list' ? 'type-title-2' : 'type-title-1')}>{title}</h1>
            {titleAside}
            {actions && <div className="flex items-center gap-1">{actions}</div>}
          </div>
          {slug && <div className="-mt-2 pb-3">{slug}</div>}
        </header>
        <div id={pane === 'list' ? undefined : 'bh-main-content'} className={cx(!bleed && (pane === 'list' ? 'px-5 pb-8' : 'px-8 pb-16'), !bleed && pane !== 'list' && MAX[maxWidth])}>
          {children}
        </div>
      </div>
      {footer && <div className="shrink-0 border-t border-line bg-bg">{footer}</div>}
    </div>
  );
};

/**
 * List/detail split (SCREENS §0.3). Expanded: 360px list pane + fluid detail pane.
 * Compact: shows the detail when a child route is active, otherwise the list.
 */
export const SplitView = ({ list, children, hasDetail, empty, listWidth = 360 }: { list: ReactNode; children?: ReactNode; hasDetail: boolean; empty?: ReactNode; listWidth?: number }) => {
  const expanded = useExpanded();
  if (!expanded) return <>{hasDetail ? children : list}</>;
  return (
    <div className="flex h-full min-h-0">
      <div className="h-full min-h-0 shrink-0 border-r border-line" style={{ width: listWidth }}>
        {list}
      </div>
      <div className="h-full min-h-0 min-w-0 flex-1">{hasDetail ? children : (empty ?? <EmptyDetail />)}</div>
    </div>
  );
};

const EmptyDetail = () => (
  <div className="grid h-full place-items-center p-8">
    <p className="type-body-sm text-ink-3">Select an item to see its details.</p>
  </div>
);
