/**
 * Kill switch (JOURNEYS §8). Asymmetric friction: stopping is one confirm; resuming is a review
 * checklist (screens/panic). The confirm sheet opens instantly, focus starts on the title, and turns
 * into a status board after the press. The panic band shows on every screen while panicked.
 */
import { ArrowRight, Check, Stop } from '@phosphor-icons/react';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { Link, Button as RACButton } from 'react-aria-components';
import { useApi, useMutationApi } from '../api/index.ts';
import { t } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';
import { clock } from '../lib/format.ts';
import { haptic } from '../lib/haptics.ts';
import { announce } from '../lib/live.ts';
import { Button } from '../ui/Button.tsx';
import { Readout } from '../ui/Meta.tsx';
import { Sheet } from '../ui/Sheet.tsx';

interface PanicCtx {
  open: () => void;
}
const Ctx = createContext<PanicCtx>({ open: () => {} });
export const usePanicSheet = () => useContext(Ctx);

/** Panic state + when it started (from the audit log; null when not panicked). */
export const usePanicState = () => {
  const status = useApi('system.status', undefined, { refetchInterval: 30_000 });
  const panic = !!status.data?.panic;
  const audit = useApi('audit.query', { severity: 'security', limit: 100 }, { enabled: panic });
  const since = panic ? audit.data?.events.find((e) => e.type === 'panic')?.at : undefined;
  return { panic, since, loaded: status.isSuccess };
};

/** Live counts for the confirm body: sessions · schedules · channels · cloud daemons. */
export const usePanicCounts = (enabled = true) => {
  const sessions = useApi('session.list', undefined, { enabled });
  const schedules = useApi('schedule.list', undefined, { enabled });
  const channels = useApi('channel.list', undefined, { enabled });
  const deployments = useApi('deploy.list', undefined, { enabled });
  return {
    sessions:
      sessions.data?.sessions.filter(
        (s) => s.status === 'running' || s.status === 'queued' || s.status === 'idle',
      ).length ?? 0,
    schedules: schedules.data?.schedules.filter((s) => s.enabled && !s.paused).length ?? 0,
    channels:
      channels.data?.channels.filter((c) => c.status === 'connected' || c.status === 'connecting').length ??
      0,
    clouds:
      deployments.data?.deployments.filter((d) => d.status === 'running' || d.status === 'provisioning')
        .length ?? 0,
  };
};

type Counts = ReturnType<typeof usePanicCounts>;
const LEDGER = ['sessions', 'schedules', 'channels', 'clouds'] as const;

/**
 * The manifest of what stops: one row per kind with the count, the noun and the verb. Before the press
 * the boxes are empty; after it they tick one by one as each part confirms — the same rows, so the
 * owner sees the plan turn into the result (DESIGN §1 "Unflappable": calm, specific).
 */
const Ledger = ({ counts, done }: { counts: Counts; done: number }) => (
  <ul
    aria-label={t('panic.panic.whatWillStop')}
    className="flex flex-col overflow-hidden rounded-lg border border-line bg-surface"
  >
    {LEDGER.map((k, i) => {
      const ticked = i < done;
      return (
        <li
          key={k}
          className="flex min-h-12 items-center gap-3 border-b border-line px-4 last:border-b-0"
          data-done={ticked || undefined}
        >
          <span
            aria-hidden="true"
            className={cx(
              'grid size-5 shrink-0 place-items-center rounded-xs transition-colors duration-[var(--dur-fast)]',
              ticked ? 'bg-ink text-bg' : 'border border-line-strong',
            )}
          >
            {ticked && <Check size={12} weight="bold" />}
          </span>
          <span className="min-w-8 font-mono text-[15px] font-semibold text-ink tabular-nums">
            {counts[k]}
          </span>
          <span className="min-w-0 flex-1 type-body-sm text-ink">
            {t(`panic.ledger.${k}`, { count: counts[k] })}
          </span>
          <span className="type-meta text-ink-2">
            {ticked ? t(`panic.ledger.${k}Done`) : t(`panic.ledger.${k}Verb`)}
            <span className="sr-only">{ticked ? ` ${t('panic.ledger.confirmed')}` : ''}</span>
          </span>
        </li>
      );
    })}
  </ul>
);

/** Confirm → pending → status board. Reused by the /panic page (inline) and the global sheet. */
export const PanicConfirm = ({
  onDone,
  onStopped,
  inline,
}: {
  onDone?: () => void;
  /** Fires once the daemon confirmed (the sheet swaps its title and drops Cancel). */
  onStopped?: () => void;
  inline?: boolean;
}) => {
  const live = usePanicCounts();
  const [snapshot, setSnapshot] = useState<Counts | null>(null);
  const [done, setDone] = useState(0);
  const panic = useMutationApi('system.panic');

  const run = () => {
    haptic('warn');
    const snap = live;
    panic.mutate(
      { reason: undefined },
      {
        onSuccess: () => {
          setSnapshot(snap);
          onStopped?.();
          LEDGER.forEach((_, i) => {
            setTimeout(() => setDone((d) => Math.max(d, i + 1)), 180 * (i + 1));
          });
          announce(`${t('panic.done')} ${t('panic.ledger.cloudsAck', { count: snap.clouds })}`, 'assertive');
        },
        onError: (e) => announce(`Couldn't stop everything: ${e.message}`, 'assertive'),
      },
    );
  };

  if (snapshot) {
    return (
      <div className="flex flex-col gap-4">
        {inline && <p className="type-title-3 text-ink">{t('panic.done')}</p>}
        <Ledger counts={snapshot} done={done} />
        <p className="type-body-sm text-ink-2">{t('panic.panic.nothingRestartsUntilYou')}</p>
        {onDone && (
          <Button variant="secondary" fullWidth onPress={onDone}>
            {t('panic.panic.close')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {inline && <h2 className="type-title-2 text-ink">{t('panic.title')}</h2>}
      <p className="type-body text-ink-2">{t('panic.lead')}</p>
      <Ledger counts={live} done={0} />
      <Button
        variant="destructive"
        size="lg"
        fullWidth
        icon={<Stop size={20} weight="fill" aria-hidden="true" />}
        isPending={panic.isPending}
        onPress={run}
      >
        {panic.isPending ? t('panic.stopping') : t('panic.button')}
      </Button>
      <p className="type-meta text-ink-2">{t('panic.after')}</p>
    </div>
  );
};

export const PanicProvider = ({ children }: { children: ReactNode }) => {
  const [isOpen, setOpenState] = useState(false);
  const [stopped, setStopped] = useState(false);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    if (!v) setStopped(false);
  };
  const value = useMemo(() => ({ open: () => setOpenState(true) }), []);
  return (
    <Ctx.Provider value={value}>
      {children}
      <Sheet
        isOpen={isOpen}
        onOpenChange={setOpen}
        title={stopped ? t('panic.done') : t('panic.title')}
        role="alertdialog"
        focusTitle
        isDismissable={false}
        footer={
          stopped ? undefined : (
            <Button variant="secondary" fullWidth onPress={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
          )
        }
      >
        {isOpen && <PanicConfirm onDone={() => setOpen(false)} onStopped={() => setStopped(true)} />}
      </Sheet>
    </Ctx.Provider>
  );
};

/** Square Stop icon button for the compact top bar (always on Home). */
export const PanicButton = () => {
  const { open } = usePanicSheet();
  const { panic } = usePanicState();
  if (panic) return null;
  // A labelled kill switch, not a stray red square: the word is visible, so is the shape.
  return (
    <RACButton
      aria-label={t('panic.button')}
      onPress={open}
      className="ml-0.5 inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md px-2.5 type-label text-stop-text outline-none transition-colors duration-[var(--dur-fast)] data-[hovered]:bg-stop-wash data-[pressed]:bg-stop-wash data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus"
    >
      <span
        aria-hidden="true"
        className="grid size-[18px] place-items-center rounded-xs border-[1.5px] border-current"
      >
        <span className="size-2 rounded-[1px] bg-current" />
      </span>
      {t('panic.short')}
    </RACButton>
  );
};

/** Hatched band, sticky under the top bar on every screen while panicked. */
export const PanicBand = ({ className, showReadout }: { className?: string; showReadout?: boolean }) => {
  const { panic, since } = usePanicState();
  if (!panic) return null;
  const time = since ? clock(since) : '—';
  return (
    <section
      aria-labelledby="bh-panic-band"
      className={cx('relative overflow-hidden border-b border-line bg-stop-wash text-ink', className)}
      data-panic-band=""
    >
      <span aria-hidden="true" className="hatch pointer-events-none absolute inset-0 text-stop-text" />
      <div className="relative flex min-h-12 items-center gap-3 px-gutter py-2">
        <Stop size={18} weight="fill" className="shrink-0 text-stop-text" aria-hidden="true" />
        <h2 id="bh-panic-band" className="min-w-0 flex-1 type-body-sm font-semibold">
          {showReadout ? (
            <span className="flex flex-wrap items-baseline gap-x-2">
              Everything is stopped · since{' '}
              <Readout size="md" tone="stop">
                {time}
              </Readout>
            </span>
          ) : (
            t('panic.band', { time })
          )}
        </h2>
        <Link
          href="/panic"
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md bg-surface px-3 type-label text-ink outline-none bh-focus-inset data-[hovered]:bg-sunken border border-line-strong"
        >
          {t('panic.review')}
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
};
