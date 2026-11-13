/**
 * Onboarding frame (SCREENS §11): stepper rail (vertical 280px on expanded, horizontal nodes + "3 of 6"
 * on compact), eyebrow `03 · IDENTITY`, title-1, lede, content (max 640, left-aligned), CLI strip, and
 * the action bar: Back · Skip (quiet) · `Continue · <next step>` (primary, sticky on compact).
 * Uses 100svh so the keyboard never shifts the stage.
 */
import { ArrowLeft, ArrowRight } from '@phosphor-icons/react';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { useExpanded } from '../../lib/media.ts';
import { Wordmark } from '../../shell/Wordmark.tsx';
import { Button } from '../../ui/Button.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { Stepper } from '../../ui/Stepper.tsx';
import { completedCount, SETUP_STEPS, type SetupStep, STEP_LABEL, useSetupProgress } from './progress.ts';

export const useGoStep = () => {
  const navigate = useNavigate();
  return (s: SetupStep | 'next') => void navigate({ to: '/setup/$step', params: { step: s } });
};

export interface StepAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  pending?: boolean;
  icon?: ReactNode;
}

export const StepFrame = ({
  step,
  title,
  lede,
  children,
  primary,
  skip,
  cli,
}: {
  /** `next` = the summary after step 06. */
  step: SetupStep | 'next';
  title: string;
  lede?: ReactNode;
  children: ReactNode;
  primary?: StepAction;
  skip?: StepAction;
  cli?: string;
}) => {
  const expanded = useExpanded();
  const go = useGoStep();
  const [progress] = useSetupProgress();
  const i = step === 'next' ? SETUP_STEPS.length : SETUP_STEPS.indexOf(step);
  const labels = SETUP_STEPS.map((s) => STEP_LABEL[s]);
  const prev = i > 0 ? SETUP_STEPS[i - 1] : undefined;
  const done = completedCount(progress);

  const actions = (primary || skip || prev) && (
    <div className={cx('flex items-center gap-2', expanded ? 'mt-10' : 'px-gutter py-3')}>
      {prev && (
        <Button
          variant="secondary"
          icon={<ArrowLeft size={16} aria-hidden="true" />}
          onPress={() => go(prev)}
          aria-label={t('a11y.backTo', { label: STEP_LABEL[prev] })}
        >
          {expanded ? t('setup.frame.back') : ''}
        </Button>
      )}
      <span className="flex-1" />
      {skip && (
        <Button variant="quiet" onPress={skip.onPress} isPending={skip.pending}>
          {skip.label}
        </Button>
      )}
      {primary && (
        <Button
          variant="primary"
          size={expanded ? 'md' : 'lg'}
          isDisabled={primary.disabled}
          isPending={primary.pending}
          onPress={primary.onPress}
          icon={primary.icon ?? <ArrowRight size={16} weight="bold" aria-hidden="true" />}
        >
          {primary.label}
        </Button>
      )}
    </div>
  );

  const head = (
    <div className="flex flex-col gap-2">
      {expanded && (
        <p className="type-micro text-ink-2">
          {step === 'next'
            ? t('setup.frame.done')
            : `${String(i + 1).padStart(2, '0')} · ${STEP_LABEL[step]}`}
        </p>
      )}
      <h1 className="type-title-1 text-ink">{title}</h1>
      {lede && <div className="max-w-[60ch] type-body text-ink-2">{lede}</div>}
    </div>
  );

  const body = (
    <>
      {head}
      <div className="mt-6 flex flex-col gap-6">{children}</div>
      {cli && <CliStrip command={cli} className="mt-8" />}
    </>
  );

  if (expanded) {
    return (
      <div className="grid min-h-svh grid-cols-[280px_1fr]">
        <aside
          className="sticky top-0 flex h-svh flex-col border-r border-line px-6 py-6"
          aria-label={t('setup.frame.setupProgress')}
        >
          <Wordmark />
          <p className="mt-8 type-meta text-ink-2">
            {step === 'next' ? t('setup.frame.setupComplete') : `Step ${i + 1} of ${SETUP_STEPS.length}`}
            {done > 0 && step !== 'next' ? ` · ${done} done` : ''}
          </p>
          <Stepper
            className="mt-4"
            orientation="vertical"
            steps={labels}
            current={Math.min(i, SETUP_STEPS.length)}
            onStepPress={(n) => go(SETUP_STEPS[n]!)}
          />
          <p className="mt-auto type-body-sm text-ink-2">{t('setup.frame.everythingHereCanBe')}</p>
        </aside>
        <main className="min-w-0 px-10 py-14" id="bh-main-content">
          <div className="max-w-[640px]">
            {body}
            {actions}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh flex-col">
      <header className="px-gutter pt-[calc(var(--bh-safe-top)+16px)]">
        <div className="mb-5 flex items-center justify-between">
          <Wordmark />
          <span className="type-meta text-ink-2">
            {step === 'next' ? 'done' : `${i + 1} of ${SETUP_STEPS.length}`}
          </span>
        </div>
        <Stepper
          steps={labels}
          current={Math.min(i, SETUP_STEPS.length)}
          onStepPress={(n) => go(SETUP_STEPS[n]!)}
        />
      </header>
      <main className="flex-1 px-gutter pt-6 pb-10" id="bh-main-content">
        {body}
      </main>
      {actions && (
        <div className="sticky bottom-0 z-20 border-t border-line bg-bg pb-[var(--bh-safe-bottom)]">
          {actions}
        </div>
      )}
    </div>
  );
};
