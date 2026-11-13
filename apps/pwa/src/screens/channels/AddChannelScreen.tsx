/**
 * Add a channel — provider picker, SCREENS §5. Route: /channels/add → /channels/add/$provider/1.
 * Unfinished setups are offered first ("Resume Telegram · 05 Pair · 3 min ago") so leaving for a
 * provider's site never means starting over (save-and-resume pattern; see ChannelWizardScreen header).
 */
import { ArrowCounterClockwise, CaretRight, PuzzlePiece } from '@phosphor-icons/react';
import { Link } from 'react-aria-components';
import { providerMonogram, useApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { ago } from '../../lib/format.ts';
import { Screen } from '../../shell/Screen.tsx';
import { Button } from '../../ui/Button.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { Eyebrow, LetterTile, MetaLine } from '../../ui/Meta.tsx';
import { ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { type ChannelDraft, clearDraft, useDrafts } from './draft.ts';
import { DEFAULT_STEPS, normalizeSteps, providerMeta, STEP_LABEL } from './providers.ts';

const FALLBACK = Object.entries(DEFAULT_STEPS).map(([provider, steps]) => ({
  provider,
  displayName: providerMeta(provider).name,
  steps: steps as unknown[],
}));

const rowClass =
  'group flex min-h-16 items-center gap-3 px-4 py-3 outline-none data-[hovered]:bg-sunken data-[pressed]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus';

export const ResumeRow = ({ d, steps }: { d: ChannelDraft; steps: string[] }) => {
  const meta = providerMeta(d.provider);
  const stepId = steps[Math.min(steps.length, d.step) - 1] ?? 'create';
  return (
    <li className="flex items-center border-b border-line last:border-b-0">
      <Link href={`/channels/add/${d.provider}/${d.step}`} className={cx(rowClass, 'min-w-0 flex-1')}>
        <LetterTile code={providerMonogram(d.provider)} tone="flare" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="type-title-3 text-ink">{t('channels.add.resume', { provider: meta.name })}</span>
          <MetaLine
            items={[
              `${String(d.step).padStart(2, '0')} ${STEP_LABEL[stepId] ?? stepId}`,
              d.identity?.handle ?? d.channel,
              ago(d.updatedAt),
            ]}
          />
        </span>
        <CaretRight size={18} className="shrink-0 text-ink-2" aria-hidden="true" />
      </Link>
      <Button
        variant="quiet"
        size="sm"
        className="mr-2 text-ink-2!"
        onPress={() => clearDraft(d.provider)}
        aria-label={t('channels.add.discardLabel', { provider: meta.name })}
      >
        {t('channels.add.discard')}
      </Button>
    </li>
  );
};

export const AddChannelScreen = () => {
  const q = useApi('channel.providers');
  const showSkeleton = useDelayedLoading(q.isPending);
  const providers = q.data?.providers ?? (q.error ? FALLBACK : []);
  const drafts = useDrafts(providers.map((p) => p.provider));
  const stepsOf = (p: string) => normalizeSteps(p, providers.find((x) => x.provider === p)?.steps);

  return (
    <Screen
      title={t('channels.add.title')}
      back={{ href: '/channels', label: t('nav.channels') }}
      pane="detail"
      maxWidth="form"
      crumbs={[{ label: t('nav.channels'), href: '/channels' }, { label: t('channels.add.crumb') }]}
    >
      <div className="flex flex-col gap-6">
        <p className="max-w-[52ch] type-body text-ink-2">{t('channels.add.lead')}</p>

        {drafts.length > 0 && (
          <section aria-labelledby="add-resume">
            <Eyebrow id="add-resume" count={drafts.length}>
              <span className="inline-flex items-center gap-1.5">
                <ArrowCounterClockwise size={12} weight="bold" aria-hidden="true" />
                {t('channels.add.unfinished')}
              </span>
            </Eyebrow>
            <ul className="overflow-hidden rounded-lg border border-line bg-flare-wash">
              {drafts.map((d) => (
                <ResumeRow key={d.provider} d={d} steps={stepsOf(d.provider)} />
              ))}
            </ul>
          </section>
        )}

        {q.error && (
          <ErrorState title={t('channels.add.error')} details={q.error} onRetry={() => void q.refetch()}>
            {t('channels.add.errorBody')}
          </ErrorState>
        )}

        <section aria-labelledby="add-providers">
          <Eyebrow id="add-providers">{t('channels.add.providers')}</Eyebrow>
          {q.isPending ? (
            showSkeleton ? (
              <Skeleton variant="list" count={4} label={t('channels.add.loading')} />
            ) : null
          ) : (
            <ul className="overflow-hidden rounded-lg border border-line bg-surface">
              {providers.map((p) => {
                const meta = providerMeta(p.provider);
                const draft = drafts.find((d) => d.provider === p.provider);
                return (
                  <li key={p.provider} className="border-b border-line last:border-b-0">
                    <Link href={`/channels/add/${p.provider}/1`} className={rowClass}>
                      <LetterTile code={providerMonogram(p.provider)} />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="type-title-3 text-ink">{p.displayName}</span>
                        <MetaLine
                          items={[
                            meta.how,
                            t('channels.add.minutes', { count: meta.minutes }),
                            draft && { value: t('channels.add.inProgress'), tone: 'flare' },
                          ]}
                        />
                      </span>
                      <CaretRight size={18} className="shrink-0 text-ink-2" aria-hidden="true" />
                    </Link>
                  </li>
                );
              })}
              <li className="flex min-h-16 items-start gap-3 px-4 py-3">
                <span
                  className="grid size-7 shrink-0 place-items-center rounded-sm bg-sunken text-ink-2"
                  aria-hidden="true"
                >
                  <PuzzlePiece size={16} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="type-title-3 text-ink">{t('channels.add.plugin')}</span>
                  <span className="type-body-sm text-ink-2">{t('channels.add.pluginBody')}</span>
                </span>
              </li>
            </ul>
          )}
        </section>
        <CliStrip command="beamhop channel add telegram" />
      </div>
    </Screen>
  );
};
