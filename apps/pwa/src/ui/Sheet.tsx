/**
 * Sheet (DESIGN §9.2): bottom sheet on compact with drag-to-dismiss (25% height or 800 px/s down,
 * grabber/header only so content scroll keeps working) + a 44px Close button and Esc as the
 * non-drag alternative (WCAG 2.5.7). ≥1024px renders as a centered 560px dialog (or a right pane).
 * Focus is trapped by RAC Modal; scrim click closes only non-destructive sheets.
 */
import { X } from '@phosphor-icons/react';
import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { type ReactNode, useRef } from 'react';
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { t } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';
import { haptic } from '../lib/haptics.ts';
import { useExpanded } from '../lib/media.ts';
import { Button, type ButtonVariant, IconButton } from './Button.tsx';
import { reduced, spring, useReduced } from './motion.ts';

const MotionOverlay = motion.create(ModalOverlay);
const MotionModal = motion.create(Modal);

export interface SheetProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Small mono line under the title. */
  subtitle?: ReactNode;
  children: ReactNode;
  /** Sticky footer (decision buttons). */
  footer?: ReactNode;
  /** Scrim click / drag closes. Set false for destructive confirmations. Esc and Close always work. */
  isDismissable?: boolean;
  /** Desktop presentation. */
  desktop?: 'dialog' | 'pane';
  /** Full height on compact (diff viewer, details). */
  full?: boolean;
  /** Visually hide the close button (still present for keyboard/SR). Rarely needed. */
  role?: 'dialog' | 'alertdialog';
  /** Move initial focus to the title instead of the first control (read consequences first). */
  focusTitle?: boolean;
  className?: string;
}

export const Sheet = ({
  isOpen,
  onOpenChange,
  title,
  subtitle,
  children,
  footer,
  isDismissable = true,
  desktop = 'dialog',
  full,
  role = 'dialog',
  focusTitle,
  className,
}: SheetProps) => {
  const expanded = useExpanded();
  const reduce = useReduced();
  const controls = useDragControls();
  const ref = useRef<HTMLDivElement>(null);
  const asSheet = !expanded;
  const asPane = expanded && desktop === 'pane';

  const enter = reduce
    ? { opacity: 0 }
    : asSheet
      ? { y: '100%' }
      : asPane
        ? { x: 40, opacity: 0 }
        : { y: 12, opacity: 0, scale: 0.98 };

  return (
    <AnimatePresence>
      {isOpen && (
        <MotionOverlay
          isOpen
          onOpenChange={onOpenChange}
          isDismissable={isDismissable}
          className={cx(
            'fixed inset-0 z-50 flex bg-scrim',
            asSheet ? 'items-end' : asPane ? 'justify-end' : 'items-center justify-center p-6',
          )}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduce ? reduced : { duration: 0.2 }}
        >
          <MotionModal
            ref={ref}
            className={cx(
              'relative flex w-full flex-col bg-surface outline-none',
              asSheet && 'max-h-[92dvh] rounded-t-[20px] shadow-sheet',
              asSheet && full && 'h-[92dvh]',
              asPane && 'h-dvh max-w-[480px] border-l border-line shadow-sheet',
              !asSheet &&
                !asPane &&
                'max-h-[min(88dvh,800px)] max-w-[560px] rounded-lg border border-line shadow-pop',
              className,
            )}
            initial={enter}
            animate={{ y: 0, x: 0, opacity: 1, scale: 1 }}
            exit={enter}
            transition={reduce ? reduced : spring.sheet}
            drag={asSheet && !reduce ? 'y' : false}
            dragControls={controls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 1 }}
            onDragEnd={(_e, info) => {
              const h = ref.current?.offsetHeight ?? 600;
              if (info.offset.y > h * 0.25 || info.velocity.y > 800) {
                haptic('tick');
                onOpenChange(false);
              }
            }}
          >
            <Dialog role={role} className="flex min-h-0 flex-1 flex-col outline-none">
              {({ close }) => (
                <>
                  <div
                    className={cx('shrink-0 select-none', asSheet && 'touch-none')}
                    onPointerDown={(e) => {
                      if (asSheet && !reduce && !(e.target as HTMLElement).closest('button'))
                        controls.start(e);
                    }}
                  >
                    {asSheet && (
                      <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 rounded-full bg-line-strong" />
                    )}
                    <div className="flex items-start gap-3 pt-3 pr-2 pb-2 pl-4 expanded:pt-4 expanded:pl-6">
                      <div className="min-w-0 flex-1 pt-2">
                        <Heading
                          slot="title"
                          tabIndex={focusTitle ? -1 : undefined}
                          autoFocus={focusTitle}
                          className="type-title-2 text-ink outline-none"
                        >
                          {title}
                        </Heading>
                        {subtitle && <div className="mt-0.5 type-meta text-ink-2">{subtitle}</div>}
                      </div>
                      <IconButton
                        label={t('ui.sheet.close')}
                        icon={<X size={20} />}
                        onPress={close}
                        tooltip={false}
                      />
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 expanded:px-6">
                    {children}
                  </div>
                  {footer && (
                    <div className="shrink-0 border-t border-line bg-surface px-4 pt-3 pb-[max(12px,var(--bh-safe-bottom))] expanded:px-6 expanded:pb-4">
                      {footer}
                    </div>
                  )}
                </>
              )}
            </Dialog>
          </MotionModal>
        </MotionOverlay>
      )}
    </AnimatePresence>
  );
};

export interface ConfirmDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the thing: **Delete reviewer?** */
  title: string;
  /** States the consequence. */
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  variant?: Extract<ButtonVariant, 'destructive' | 'primary' | 'allow'>;
  isPending?: boolean;
}

/**
 * Destructive confirms name the thing and the consequence (DESIGN §11.8). Not scrim-dismissable;
 * focus starts on the title so screen-reader users hear the consequence first, then Confirm, then Cancel.
 */
export const ConfirmDialog = ({
  isOpen,
  onOpenChange,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  variant = 'destructive',
  isPending,
}: ConfirmDialogProps) => (
  <Sheet
    isOpen={isOpen}
    onOpenChange={onOpenChange}
    title={title}
    isDismissable={false}
    role="alertdialog"
    focusTitle
    footer={
      <div className="grid gap-2 expanded:grid-cols-2">
        <Button
          variant={variant}
          size="lg"
          fullWidth
          isPending={isPending}
          onPress={() => void onConfirm()}
          className="expanded:order-2"
        >
          {confirmLabel}
        </Button>
        <Button variant="secondary" size="lg" fullWidth onPress={() => onOpenChange(false)}>
          {cancelLabel}
        </Button>
      </div>
    }
  >
    <div className="type-body text-ink-2">{children}</div>
  </Sheet>
);
