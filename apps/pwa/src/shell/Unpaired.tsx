/**
 * First screen of a browser that has nothing to talk to (`useConnection().kind === 'none'`): the hosted
 * app before pairing, or a daemon-served page without its token. Instead of a shell full of skeletons
 * that never resolve, say what this is and offer the two ways in (DESIGN §10: what this is · one action).
 */
import { DeviceMobile, Laptop, TerminalWindow } from '@phosphor-icons/react';
import { t } from '../i18n/index.ts';
import { isDesktop, useShowCli } from '../lib/desktop.ts';
import { LinkButton } from '../ui/Button.tsx';
import { CliStrip } from '../ui/CliStrip.tsx';
import { Eyebrow } from '../ui/Meta.tsx';
import { RouteLine } from '../ui/Status.tsx';
import { RestartBeamhopButton } from './DesktopActions.tsx';
import { Wordmark } from './Wordmark.tsx';

export const Unpaired = () => {
  const cli = useShowCli();
  return (
    <main
      id="bh-main-content"
      className="mx-auto flex min-h-svh w-full max-w-[640px] flex-col gap-8 px-gutter pt-[max(24px,var(--bh-safe-top))] pb-[max(24px,var(--bh-safe-bottom))]"
    >
      <Wordmark />
      <div className="flex flex-col gap-3">
        <p className="type-micro text-ink-2">{t('unpaired.eyebrow')}</p>
        <h1 className="type-title-1 text-ink">{t('unpaired.title')}</h1>
        <p className="type-body text-ink-2">{t('unpaired.lede')}</p>
        <RouteLine
          className="mt-2"
          nodes={[
            { label: t('unpaired.route.phone'), kind: 'channel' },
            { label: t('unpaired.route.relays'), kind: 'relay' },
            { label: t('unpaired.route.computer'), kind: 'agent' },
          ]}
          state="broken"
          reason={t('unpaired.route.reason')}
        />
      </div>

      <section
        aria-labelledby="unpaired-pair"
        className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
      >
        <Eyebrow id="unpaired-pair">{t('unpaired.pair.eyebrow')}</Eyebrow>
        <div className="flex items-start gap-3">
          <DeviceMobile size={22} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-2" />
          <p className="type-body-sm text-ink-2">{t(cli ? 'unpaired.pair.body' : 'unpaired.pair.bodyApp')}</p>
        </div>
        <LinkButton href="/pair" variant="primary" className="self-start">
          {t('conn.none.pair')}
        </LinkButton>
      </section>

      <section aria-labelledby="unpaired-local" className="flex flex-col gap-3">
        <Eyebrow id="unpaired-local">{t('unpaired.local.eyebrow')}</Eyebrow>
        <div className="flex items-start gap-3">
          <Laptop size={22} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-2" />
          <p className="type-body-sm text-ink-2">
            {t(
              isDesktop()
                ? 'unpaired.local.bodyDesktop'
                : cli
                  ? 'unpaired.local.body'
                  : 'unpaired.local.bodyApp',
            )}
          </p>
        </div>
        {isDesktop() && <RestartBeamhopButton className="self-start" />}
        <CliStrip command="beamhop ui" />
      </section>

      <p className="mt-auto flex items-center gap-2 type-body-sm text-ink-2">
        <TerminalWindow size={16} aria-hidden="true" />
        {/* A full page load: the demo daemon is chosen at boot. */}
        <a href="/?mock=1" className="text-ink underline decoration-1 underline-offset-[3px]">
          {t('unpaired.demo')}
        </a>
      </p>
    </main>
  );
};
