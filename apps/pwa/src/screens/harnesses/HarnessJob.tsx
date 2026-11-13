/**
 * Install / Update / Log in for one harness, with progress (docs/desktop-ux.md §4–5). Shared by the
 * Harnesses screen, onboarding step 02 and New agent. Plain steps, a Cancel button, a collapsed
 * "Show details" with the raw output, the job's own plain message when it fails, and Try again.
 * Only the computer itself can run programs (`system.whoami` via `local`); elsewhere the buttons are
 * disabled with "Open beamhop on your computer…".
 */
import { type HarnessView, isJobFinished } from '@beamhop/core';
import { ArrowClockwise, ArrowUpRight, CaretRight, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { useEffect } from 'react';
import { Disclosure, DisclosurePanel, Heading, Button as RACButton } from 'react-aria-components';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { Button } from '../../ui/Button.tsx';
import { CopyButton } from '../../ui/CliStrip.tsx';
import { HopMeter } from '../../ui/glyphs/index.tsx';
import { managesLogin } from './HarnessLogin.tsx';
import {
  type HarnessActionKind,
  harnessAction,
  type JobKind,
  jobProgress,
  jobStepLabel,
  useCanRunPrograms,
  useHarnessJob,
} from './jobs.ts';

export interface HarnessUpdateInfo {
  available: boolean;
  required: boolean;
  latest?: string;
}

const ExternalLink = ({ href, children }: { href: string; children: string }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex min-h-11 items-center gap-1 type-label text-ink underline underline-offset-[3px]"
  >
    {children}
    <ArrowUpRight size={14} aria-hidden="true" />
    <span className="sr-only"> {t('harnesses.harnesses.opensInANew')}</span>
  </a>
);

/** Collapsed raw output (and what runs), copyable. */
export const JobDetails = ({ lines, command }: { lines: string[]; command?: string[] }) => {
  const text = [command?.length ? `$ ${command.join(' ')}` : '', ...lines].filter(Boolean).join('\n');
  if (!text) return null;
  return (
    <Disclosure className="rounded-md border border-line">
      <Heading level={4} className="m-0">
        <RACButton
          slot="trigger"
          className="group flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left type-label text-ink-2 outline-none data-[hovered]:text-ink data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
        >
          <CaretRight
            size={14}
            aria-hidden="true"
            className="shrink-0 group-aria-expanded:rotate-90 motion-safe:transition-transform"
          />
          {t('harnesses.job.details')}
        </RACButton>
      </Heading>
      <DisclosurePanel>
        <div className="flex items-start gap-1 rounded-b-md border-t border-line bg-sunken py-1 pr-1 pl-3">
          <pre
            tabIndex={0}
            aria-label={t('harnesses.job.output')}
            className="max-h-48 min-w-0 flex-1 overflow-auto py-2 type-code whitespace-pre text-ink outline-none focus-visible:outline-2 focus-visible:outline-focus"
          >
            {text}
          </pre>
          <CopyButton value={text} label={t('harnesses.job.copyOutput')} compact />
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
};

const ACTION_LABEL: Record<Exclude<HarnessActionKind, 'manual'>, (name: string) => [string, string]> = {
  install: (name) => [t('harnesses.job.install'), t('harnesses.job.installFor', { name })],
  update: (name) => [t('harnesses.job.update'), t('harnesses.job.updateFor', { name })],
  login: (name) => [t('harnesses.job.login'), t('harnesses.job.loginFor', { name })],
};

const REMOTE_NOTE: Record<JobKind, string> = {
  install: 'harnesses.job.remote.install',
  update: 'harnesses.job.remote.update',
  login: 'harnesses.job.remote.login',
};

export const HarnessJobControls = ({
  h,
  update,
  onManual,
  className,
  primary,
  forceAction,
  method,
  actionLabel,
}: {
  h: HarnessView;
  update?: HarnessUpdateInfo;
  /** Open the Install sheet (manual steps) when beamhop can't install it by itself. */
  onManual?: () => void;
  className?: string;
  /** Use the primary button style for the action. */
  primary?: boolean;
  /** Offer this action whatever the harness's status (e.g. browser sign-in inside the login sheet). */
  forceAction?: JobKind;
  /** With `forceAction="login"`: the subscription sign-in method to use. */
  method?: string;
  /** Button text instead of the default ("Sign in with ChatGPT plan"). */
  actionLabel?: string;
}) => {
  const job = useHarnessJob(h.id);
  const canRun = useCanRunPrograms();
  const action =
    forceAction ?? harnessAction(h, { updateAvailable: update?.available, managedLogin: managesLogin(h) });
  const j = job.job;
  const finished = j ? isJobFinished(j) : false;
  const showStatus = job.starting || !!j || !!job.error;
  // "Ready" stays a moment after a job finishes, then the row shows the harness as it is now.
  const doneId = j?.step === 'done' ? j.id : undefined;
  const { dismiss } = job;
  useEffect(() => {
    if (!doneId) return;
    const timer = window.setTimeout(dismiss, 10_000);
    return () => window.clearTimeout(timer);
  }, [doneId, dismiss]);
  if (!showStatus && !action) return null;

  const command = j?.kind !== 'login' ? h.installPlan?.command : undefined;
  const retryKind: JobKind | undefined = job.kind ?? j?.kind;

  const actionButton = (() => {
    if (!action || job.running) return null;
    if (j?.step === 'failed' || j?.step === 'cancelled' || job.error) return null; // Try again instead
    if (action === 'manual') {
      return (
        <div className="flex flex-col items-start gap-1">
          <p className="type-body-sm text-ink-2">
            {t('harnesses.job.manual', { name: h.displayName })}
            {h.installPlan?.method === 'none' && (h.installPlan.reason ?? h.message)
              ? ` ${h.installPlan.reason ?? h.message}`
              : ''}
          </p>
          {onManual ? (
            <Button
              variant="secondary"
              size="sm"
              onPress={onManual}
              aria-label={t('harnesses.job.howFor', { name: h.displayName })}
            >
              {t('harnesses.job.how')}
            </Button>
          ) : (
            h.install?.url && (
              <ExternalLink href={h.install.url}>
                {t('harnesses.install.docs', { name: h.displayName })}
              </ExternalLink>
            )
          )}
        </div>
      );
    }
    const [label, aria] = ACTION_LABEL[action](h.displayName);
    return (
      <div className="flex flex-col items-start gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={primary ? 'primary' : 'secondary'}
            size="sm"
            isDisabled={!canRun}
            onPress={() => void job.start(action, method ? { method } : {})}
            aria-label={actionLabel ?? aria}
          >
            {actionLabel ?? label}
          </Button>
          {action === 'update' && update?.latest && (
            <span className="type-meta text-ink-2">
              {t('harnesses.job.updateTo', { version: update.latest })}
            </span>
          )}
        </div>
        {!canRun && (
          <p className="type-meta text-ink-2">{t(REMOTE_NOTE[action] as 'harnesses.job.remote.install')}</p>
        )}
      </div>
    );
  })();

  return (
    <div className={cx('flex flex-col gap-2', className)}>
      {showStatus && (
        <div className="flex flex-col gap-2" data-harness-job={h.id}>
          {job.running && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <HopMeter up={j ? jobProgress(j.step) : 1} total={4} busy tone="ink" />
              <span className="type-body-sm text-ink">
                {j ? jobStepLabel(j.step) : jobStepLabel('resolving')}
              </span>
              {j && (
                <Button
                  variant="quiet"
                  size="sm"
                  className="ml-auto"
                  onPress={() => void job.cancel()}
                  aria-label={t('harnesses.job.cancelFor', { name: h.displayName })}
                >
                  {t('harnesses.job.cancel')}
                </Button>
              )}
            </div>
          )}
          {job.running && j?.kind === 'login' && j.url && (
            <div className="flex flex-col gap-2 rounded-md border border-line bg-sunken px-3 py-2.5">
              <p className="type-body-sm text-ink">{t('harnesses.job.browserLead')}</p>
              <ExternalLink href={j.url}>{t('harnesses.job.openAgain')}</ExternalLink>
              {j.code && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="type-meta text-ink-2">{t('harnesses.job.code')}</span>
                  <code className="rounded-sm bg-surface px-2 py-1 type-code tracking-widest text-ink">
                    {j.code}
                  </code>
                  <CopyButton value={j.code} label={t('harnesses.job.copyCode')} />
                </div>
              )}
            </div>
          )}
          {j?.step === 'done' && (
            <p className="flex items-center gap-2 type-body-sm text-ink">
              <CheckCircle size={18} weight="fill" aria-hidden="true" className="shrink-0 text-go-text" />
              <span>{jobStepLabel('done')}</span>
              {j.message && <span className="type-meta text-ink-2">{j.message}</span>}
            </p>
          )}
          {(j?.step === 'failed' || j?.step === 'cancelled' || (job.error && !job.running)) && (
            <div className="flex flex-col items-start gap-2">
              <p className="flex items-start gap-2 type-body-sm text-ink">
                <WarningCircle
                  size={18}
                  weight="fill"
                  aria-hidden="true"
                  className={cx('mt-0.5 shrink-0', j?.step === 'cancelled' ? 'text-ink-3' : 'text-stop-text')}
                />
                <span>
                  {job.error ??
                    j?.message ??
                    (j?.step === 'cancelled' ? jobStepLabel('cancelled') : t('harnesses.job.failedBody'))}
                </span>
              </p>
              {retryKind && (
                <Button
                  variant="secondary"
                  size="sm"
                  isDisabled={!canRun}
                  icon={<ArrowClockwise size={16} aria-hidden="true" />}
                  onPress={() => void job.start(retryKind, method ? { method } : {})}
                  aria-label={t('harnesses.job.retryFor', { name: h.displayName })}
                >
                  {t('harnesses.job.retry')}
                </Button>
              )}
            </div>
          )}
          {(job.lines.length > 0 || (finished && command)) && (
            <JobDetails lines={job.lines} command={command} />
          )}
        </div>
      )}
      {(!showStatus || finished) && actionButton}
    </div>
  );
};
