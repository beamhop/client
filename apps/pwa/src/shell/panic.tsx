/**
 * Kill switch (JOURNEYS §8). Asymmetric friction: stopping is one confirm; resuming is a review
 * checklist (screens/panic). The confirm sheet opens instantly, focus starts on the title, and turns
 * into a status board after the press. The panic band shows on every screen while panicked.
 */
import { ArrowRight, Check, Stop } from '@phosphor-icons/react';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { Link } from 'react-aria-components';
import { useApi, useMutationApi } from '../api/index.ts';
import { t } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';
import { clock } from '../lib/format.ts';
import { haptic } from '../lib/haptics.ts';
import { announce } from '../lib/live.ts';
import { Button, IconButton } from '../ui/Button.tsx';
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

type BoardRow = { label: string; done: boolean };

/** Confirm → pending → status board. Reused by the /panic page (inline) and the global sheet. */
export const PanicConfirm = ({ onDone, inline }: { onDone?: () => void; inline?: boolean }) => {
  const counts = usePanicCounts();
  const [board, setBoard] = useState<BoardRow[] | null>(null);
  const panic = useMutationApi('system.panic');

  const run = () => {
    haptic('warn');
    const snapshot = counts;
    panic.mutate(
      { reason: undefined },
      {
        onSuccess: () => {
          const rows: BoardRow[] = [
            { label: `Sessions killed ${snapshot.sessions}/${snapshot.sessions}`, done: false },
            { label: `Schedules paused ${snapshot.schedules}/${snapshot.schedules}`, done: false },
            { label: `Channels disconnected ${snapshot.channels}/${snapshot.channels}`, done: false },
            { label: `Cloud daemons acknowledged ${snapshot.clouds}/${snapshot.clouds}`, done: false },
          ];
          setBoard(rows);
          rows.forEach((_, i) => {
            setTimeout(
              () => setBoard((b) => b?.map((r, j) => (j <= i ? { ...r, done: true } : r)) ?? null),
              180 * (i + 1),
            );
          });
          announce(
            `${t('panic.done')} ${snapshot.clouds} of ${snapshot.clouds} cloud daemons confirmed.`,
            'assertive',
          );
        },
        onError: (e) => announce(`Couldn't stop everything: ${e.message}`, 'assertive'),
      },
    );
  };

  if (board) {
    return (
      <div className="flex flex-col gap-4">
        <p className="type-title-3 text-ink">{t('panic.done')}</p>
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {board.map((r) => (
            <li key={r.label} className="flex min-h-11 items-center gap-3 px-4 type-meta text-ink">
              <span
                className={cx(
                  'grid size-5 place-items-center rounded-sm',
                  r.done ? 'bg-ink text-bg' : 'border border-line-strong',
                )}
              >
                {r.done && <Check size={12} weight="bold" aria-hidden="true" />}
              </span>
              {r.label}
            </li>
          ))}
        </ul>
        <p className="type-body-sm text-ink-2">Nothing restarts until you review and resume.</p>
        {onDone && (
          <Button variant="secondary" fullWidth onPress={onDone}>
            Close
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {inline && <h2 className="type-title-2 text-ink">{t('panic.title')}</h2>}
      <p className="type-body text-ink-2">{t('panic.body', counts)}</p>
      <ul className="grid grid-cols-2 gap-2 type-meta" aria-label="What will stop">
        {(
          [
            ['sessions', counts.sessions],
            ['schedules', counts.schedules],
            ['channels', counts.channels],
            ['cloud daemons', counts.clouds],
          ] as const
        ).map(([k, n]) => (
          <li key={k} className="flex items-baseline gap-2 rounded-md bg-sunken px-3 py-2">
            <span className="font-display text-2xl leading-none font-bold text-ink tabular-nums">{n}</span>
            <span className="text-ink-2">{k}</span>
          </li>
        ))}
      </ul>
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
    </div>
  );
};

export const PanicProvider = ({ children }: { children: ReactNode }) => {
  const [isOpen, setOpen] = useState(false);
  const value = useMemo(() => ({ open: () => setOpen(true) }), []);
  return (
    <Ctx.Provider value={value}>
      {children}
      <Sheet
        isOpen={isOpen}
        onOpenChange={setOpen}
        title={t('panic.title')}
        role="alertdialog"
        focusTitle
        isDismissable={false}
        footer={
          <Button variant="secondary" fullWidth onPress={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>
        }
      >
        {isOpen && <PanicConfirm onDone={() => setOpen(false)} />}
      </Sheet>
    </Ctx.Provider>
  );
};

/** Square Stop icon button for the compact top bar (always on Home). */
export const PanicButton = () => {
  const { open } = usePanicSheet();
  const { panic } = usePanicState();
  if (panic) return null;
  return (
    <IconButton
      label="Stop everything"
      shortcut="⌘⇧."
      icon={<Stop size={20} weight="fill" />}
      variant="destructive-ghost"
      onPress={open}
    />
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
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md bg-surface px-3 type-label text-ink outline-none data-[hovered]:bg-sunken border border-line-strong"
        >
          {t('panic.review')}
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
};
