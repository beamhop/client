/**
 * Toasts (DESIGN §9.2): one region, max one visible, newest replaces. Never steals focus; F6 / ⌘.
 * moves focus to it. Undo toasts show a 2px beam line shrinking over the undo window (5 s).
 * Info 4 s, undo 5 s, errors persist until dismissed. Announced through the polite live region.
 */
import { ArrowCounterClockwise, Check, WarningCircle, X } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button as RACButton } from 'react-aria-components';
import { t as tr } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';
import { announce } from '../lib/live.ts';
import { reduced, spring, useReduced } from './motion.ts';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  message: ReactNode;
  /** Plain-text version for screen readers (defaults to message when it is a string). */
  spoken?: string;
  tone?: ToastTone;
  /** Shows an Undo button and the shrinking beam line. */
  onUndo?: () => void | Promise<void>;
  /** A secondary action, e.g. `Add reason`. */
  action?: { label: string; onPress: () => void };
  /** Override duration (ms). `Infinity` persists. */
  durationMs?: number;
}

interface ActiveToast extends ToastOptions {
  id: number;
  duration: number;
}

interface ToastApi {
  show(t: ToastOptions): number;
  dismiss(id?: number): void;
}

const Ctx = createContext<ToastApi | null>(null);

export const useToast = (): ToastApi => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast must be used inside <ToastProvider>');
  return v;
};

let nextId = 1;

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toast, setToast] = useState<ActiveToast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const regionRef = useRef<HTMLElement>(null);

  const dismiss = useCallback((id?: number) => {
    setToast((t) => (id === undefined || t?.id === id ? null : t));
  }, []);

  const show = useCallback((t: ToastOptions) => {
    const id = nextId++;
    const duration = t.durationMs ?? (t.tone === 'error' ? Number.POSITIVE_INFINITY : t.onUndo ? 5000 : 4000);
    setToast({ ...t, id, duration });
    const spoken = t.spoken ?? (typeof t.message === 'string' ? t.message : '');
    if (spoken)
      announce(t.onUndo ? `${spoken}. Undo available for ${Math.round(duration / 1000)} seconds.` : spoken);
    return id;
  }, []);

  useEffect(() => {
    clearTimeout(timer.current);
    if (toast && Number.isFinite(toast.duration)) {
      timer.current = setTimeout(() => dismiss(toast.id), toast.duration);
    }
    return () => clearTimeout(timer.current);
  }, [toast, dismiss]);

  // F6 or ⌘. / Ctrl+. moves focus to the toast (desktop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F6' || ((e.metaKey || e.ctrlKey) && e.key === '.')) {
        const target = regionRef.current?.querySelector<HTMLElement>('button');
        if (target) {
          e.preventDefault();
          target.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <ToastRegion ref={regionRef} toast={toast} onDismiss={dismiss} />
    </Ctx.Provider>
  );
};

/** Marks a bar pinned to the bottom of a screen (decision bar, save bar, wizard actions). */
export const TOAST_AVOID = 'data-toast-avoid';

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * How far above the viewport bottom the toast must sit to clear every bottom bar it would cover.
 * A toast over an action bar turns a late tap on Undo into a tap on the bar's button underneath
 * (e.g. Deny on the next approval), so it always goes above. Bars outside the bottom `zone` px or
 * beside the toast's column are ignored; 0 means the default position is fine.
 */
export const toastLift = (
  bars: Box[],
  toast: Pick<Box, 'left' | 'right'>,
  vh: number,
  zone: number,
  gap = 8,
) =>
  bars.reduce((lift, b) => {
    const beside = b.right <= toast.left || b.left >= toast.right;
    const inZone = b.bottom > vh - zone && b.top < vh && b.bottom > b.top;
    return beside || !inZone ? lift : Math.max(lift, Math.ceil(vh - b.top + gap));
  }, 0);

const ToastRegion = ({
  toast,
  onDismiss,
  ref,
}: {
  toast: ActiveToast | null;
  onDismiss: (id?: number) => void;
  ref: React.Ref<HTMLElement>;
}) => {
  const reduce = useReduced();
  const own = useRef<HTMLElement>(null);
  const [lift, setLift] = useState(0);
  const visible = toast !== null;

  // Re-measure while a toast is up: bars appear, resize or move as the screen under it changes.
  useLayoutEffect(() => {
    if (!visible) {
      setLift(0);
      return;
    }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = own.current?.querySelector<HTMLElement>('[data-toast]');
        if (!el) return;
        const r = el.getBoundingClientRect();
        const bars = [...document.querySelectorAll<HTMLElement>(`[${TOAST_AVOID}]`)].map((b) =>
          b.getBoundingClientRect(),
        );
        // The zone covers the toast's default spot above the tab bar plus its own height.
        setLift(toastLift(bars, r, window.innerHeight, el.offsetHeight + 160));
      });
    };
    measure();
    const mo = new MutationObserver(measure);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [visible]);

  return (
    <section
      ref={(node) => {
        own.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as React.RefObject<HTMLElement | null>).current = node;
      }}
      aria-label={tr('ui.toast.notifications')}
      className="pointer-events-none fixed inset-x-0 z-[80] flex justify-center px-4 bottom-[max(calc(var(--bh-tabbar-h)+var(--bh-safe-bottom)+8px),var(--bh-toast-lift))] expanded:bottom-[max(24px,var(--bh-toast-lift))] expanded:pl-[calc(var(--bh-sidebar-w)+16px)]"
      style={{ ['--bh-toast-lift' as string]: `${lift}px` }}
      data-toast-region=""
    >
      <AnimatePresence>
        {toast && (
          <motion.div
            key="toast"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={reduce ? reduced : spring.snap}
            className="pointer-events-auto relative w-full max-w-[343px] overflow-hidden rounded-lg border border-line bg-surface shadow-pop expanded:max-w-[420px]"
            data-toast=""
            data-tone={toast.tone ?? 'info'}
          >
            {toast.onUndo && Number.isFinite(toast.duration) && (
              <span
                key={toast.id}
                aria-hidden="true"
                className="toast-countdown absolute inset-x-0 top-0 h-0.5 bg-flare"
                style={{ ['--bh-toast-ms' as string]: `${toast.duration}ms` }}
              />
            )}
            <div className="flex min-h-14 items-center gap-3 py-1.5 pr-1.5 pl-4">
              <span
                aria-hidden="true"
                className={cx(
                  'shrink-0',
                  toast.tone === 'error'
                    ? 'text-stop-text'
                    : toast.tone === 'success'
                      ? 'text-go-text'
                      : 'text-ink-2',
                )}
              >
                {toast.tone === 'error' ? (
                  <WarningCircle size={20} weight="bold" />
                ) : (
                  <Check size={20} weight="bold" />
                )}
              </span>
              <div className="min-w-0 flex-1 type-body-sm text-ink">{toast.message}</div>
              {toast.action && (
                <RACButton
                  onPress={() => {
                    toast.action?.onPress();
                  }}
                  className="min-h-11 shrink-0 rounded-md px-3 type-label text-ink underline-offset-[3px] data-[hovered]:underline data-[pressed]:bg-sunken"
                >
                  {toast.action.label}
                </RACButton>
              )}
              {toast.onUndo && (
                <RACButton
                  onPress={async () => {
                    onDismiss(toast.id);
                    await toast.onUndo?.();
                    announce('Undone.');
                  }}
                  className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-line-strong px-3 type-label text-ink data-[hovered]:bg-sunken data-[pressed]:bg-sunken"
                >
                  <ArrowCounterClockwise size={16} weight="bold" aria-hidden="true" />
                  Undo
                </RACButton>
              )}
              {!toast.onUndo && (
                <RACButton
                  aria-label={tr('ui.toast.dismissNotification')}
                  onPress={() => onDismiss(toast.id)}
                  className="grid size-11 shrink-0 place-items-center rounded-md text-ink-2 data-[hovered]:bg-sunken"
                >
                  <X size={16} aria-hidden="true" />
                </RACButton>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
};
