/**
 * Settings → Stop everything (SCREENS §10, JOURNEYS §8). Explains the kill switch in plain words —
 * what stops, what doesn't, how resuming works — opens the one-confirm panic sheet, and lists past panics.
 */
import { ArrowRight, Stop } from '@phosphor-icons/react';
import { useApi } from '../../api/index.ts';
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
        <span aria-hidden="true" className="hatch pointer-events-none absolute inset-0 text-stop-text" />
        <div className="relative flex flex-col gap-3">
          <h2 className="flex items-center gap-2 type-title-2 text-ink">
            <Stop size={22} weight="fill" className="text-stop-text" aria-hidden="true" />
            {panic ? 'Everything is stopped' : 'Stop everything'}
          </h2>
          <p className="type-body text-ink-2">
            {panic
              ? `Since ${since ? when(since) : 'just now'}. Nothing restarts until you review what was running.`
              : 'One press, one confirm. Use it when something looks wrong and you want it to stop now, before you understand why.'}
          </p>
          {panic ? (
            <LinkButton
              href="/panic"
              variant="primary"
              icon={<ArrowRight size={16} weight="bold" aria-hidden="true" />}
              className="self-start"
            >
              Review & resume
            </LinkButton>
          ) : (
            <Button
              variant="destructive"
              size="lg"
              className="self-start"
              icon={<Stop size={18} weight="fill" aria-hidden="true" />}
              onPress={open}
            >
              Stop everything
            </Button>
          )}
          <p className="type-meta text-ink-2">
            Also: <Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>.</Kbd> anywhere · Stop in the top bar · from any paired
            phone
          </p>
        </div>
      </div>

      <Group title="What stops" id="dz-stops">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 type-body-sm">
          {STOPS.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink">{k}</dt>
              <dd className="text-ink-2">{v}</dd>
            </div>
          ))}
        </dl>
      </Group>

      <Group title="Resuming" id="dz-resume">
        <p className="type-body-sm text-ink-2">
          Resume is a review, never automatic: you see what was running and recent security events, then pick
          what comes back. Nothing is pre-checked for you.
        </p>
      </Group>

      <Group title="History" id="dz-history">
        {events.length ? (
          <List>
            {events.map((e) => (
              <Row
                key={e.id}
                title={e.type === 'panic' ? 'Stopped everything' : 'Resumed after review'}
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
          <p className="type-body-sm text-ink-2">Never used. Good.</p>
        )}
      </Group>
      <CliStrip command="beamhop panic" />
    </div>
  );
};
