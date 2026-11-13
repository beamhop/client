/**
 * Settings → Stop everything (SCREENS §10, JOURNEYS §8). Explains the kill switch in plain words —
 * what stops, what doesn't, how resuming works — opens the one-confirm panic sheet, and lists past panics.
 */
import { ArrowRight, Stop } from '@phosphor-icons/react';
import { useApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { when } from '../../lib/format.ts';
import { usePanicSheet, usePanicState } from '../../shell/panic.tsx';
import { Button, LinkButton } from '../../ui/Button.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { Kbd, MetaLine } from '../../ui/Meta.tsx';
import { Group, List, Row } from './kit.tsx';

const STOPS = [
  ['Sessions', 'killed, mid-sentence if needed'],
  ['Schedules', 'paused'],
  ['Channels', 'disconnected; nobody can reach your agents'],
  ['Cloud daemons', 'told to do the same, and confirm'],
  ['Pending approvals', 'denied; agents are told'],
] as const;

export const DangerSection = () => {
  const { open } = usePanicSheet();
  const { panic, since } = usePanicState();
  const history = useApi('audit.query', { severity: 'security', limit: 200 });
  const all = useApi('audit.query', { limit: 500 });
  const events = [...(history.data?.events ?? []), ...(all.data?.events ?? [])]
    .filter((e) => e.type === 'panic' || e.type === 'resume')
    .filter((e, i, xs) => xs.findIndex((x) => x.id === e.id) === i)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8);

  return (
    <div className="flex flex-col gap-8">
      <div className="relative overflow-hidden rounded-lg border border-line bg-stop-wash p-4">
        <span
          aria-hidden="true"
          className="hatch pointer-events-none absolute inset-y-0 left-0 w-3 border-r border-line text-stop-text"
        />
        <div className="relative flex flex-col gap-3 pl-4">
          <h2 className="flex items-center gap-2 type-title-2 text-ink">
            <Stop size={22} weight="fill" className="text-stop-text" aria-hidden="true" />
            {panic ? t('settings.danger.everythingIsStopped') : t('settings.section.stop')}
          </h2>
          <p className="type-body text-ink-2">
            {panic
              ? `Since ${since ? when(since) : t('settings.danger.justNow')}. Nothing restarts until you review what was running.`
              : t('settings.danger.onePressOneConfirm')}
          </p>
          {panic ? (
            <LinkButton
              href="/panic"
              variant="primary"
              icon={<ArrowRight size={16} weight="bold" aria-hidden="true" />}
              className="self-start"
            >
              {t('settings.danger.reviewResume')}
            </LinkButton>
          ) : (
            <Button
              variant="destructive"
              size="lg"
              className="self-start"
              icon={<Stop size={18} weight="fill" aria-hidden="true" />}
              onPress={open}
            >
              {t('settings.section.stop')}
            </Button>
          )}
          <p className="type-meta text-ink-2">
            {t('settings.danger.also')}{' '}
            <span className="pointer-coarse:hidden">
              <Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>.</Kbd> {t('settings.danger.anywhere')}{' '}
            </span>
            {t('settings.danger.topBar')}
          </p>
        </div>
      </div>

      <Group title={t('settings.danger.whatStops')} id="dz-stops">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 type-body-sm">
          {STOPS.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink">{k}</dt>
              <dd className="text-ink-2">{v}</dd>
            </div>
          ))}
        </dl>
      </Group>

      <Group title={t('settings.danger.resuming')} id="dz-resume">
        <p className="type-body-sm text-ink-2">{t('settings.danger.resumeIsAReview')}</p>
      </Group>

      <Group title={t('settings.danger.history')} id="dz-history">
        {events.length ? (
          <List>
            {events.map((e) => (
              <Row
                key={e.id}
                title={
                  e.type === 'panic'
                    ? t('settings.danger.stoppedEverything')
                    : t('settings.danger.resumedAfterReview')
                }
                slug={
                  <MetaLine
                    items={[
                      when(e.at),
                      e.actor,
                      e.summary !== `${e.actor} stopped everything` ? e.summary : undefined,
                    ]}
                  />
                }
              />
            ))}
          </List>
        ) : (
          <p className="type-body-sm text-ink-2">{t('settings.danger.neverUsedGood')}</p>
        )}
      </Group>
      <CliStrip command="beamhop panic" />
    </div>
  );
};
