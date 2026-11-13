/**
 * Channels list — SCREENS §5, JOURNEYS §4. Routes: /channels (layout) → /channels/$id, /channels/add,
 * /channels/add/$provider/$step. Rows: tile · name · lamp (Nostr: lamp + relay hop meter `3/4 relays`)
 * and a slug line; channels that need you come first with the reason and a direct `Replace token`.
 * Live: `channel.updated` events patch the cache, so lamps and relay bars move on their own.
 * Unfinished wizard setups are offered at the top (resume after a trip to BotFather).
 */
import type { AgentView, ChannelView } from '@beamhop/core';
import { CaretRight, Plugs, Plus } from '@phosphor-icons/react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { Link } from 'react-aria-components';
import type { LampState } from '../../api/derive.ts';
import { channelLamp, PROVIDER_NAMES, providerMonogram, relayHealth, useApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { usePanicState } from '../../shell/panic.tsx';
import { EmptyPane, Screen, SplitView } from '../../shell/Screen.tsx';
import { useHasDetail } from '../../shell/ScreenStub.tsx';
import { BarAction, LinkButton } from '../../ui/Button.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { Eyebrow, LetterTile, type MetaItem, MetaLine } from '../../ui/Meta.tsx';
import { EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { SignalBars, StatusDot } from '../../ui/Status.tsx';
import { ResumeRow } from './AddChannelScreen.tsx';
import { useDrafts } from './draft.ts';
import { channelChats, DEFAULT_STEPS, normalizeSteps, transportOf } from './providers.ts';

/** Agents with a live membership on this channel. */
export const agentsOn = (name: string, agents?: AgentView[]) =>
  (agents ?? []).filter((a) =>
    a.config.memberships.some((m) => !m.revokedAt && m.target.startsWith(`${name}:`)),
  );

export const channelTitle = (c: ChannelView) =>
  c.config.provider === 'nostr'
    ? PROVIDER_NAMES.nostr!
    : (c.self?.handle ?? c.self?.displayName ?? PROVIDER_NAMES[c.config.provider] ?? c.config.name);

export const channelLampWithPanic = (c: ChannelView, panic: boolean): LampState =>
  panic && c.status === 'disconnected' ? 'panic' : channelLamp(c);

const needsAttention = (c: ChannelView) => c.status === 'error' || c.status === 'disconnected';

export const channelSlug = (c: ChannelView, agents?: AgentView[]): MetaItem[] => {
  if (c.status === 'error') return [{ value: c.error ?? t('channels.list.errorWord'), tone: 'stop' }];
  if (c.config.provider === 'nostr') {
    const s = c.config.settings;
    return [
      t('channels.list.nostrDms', { nip: String(s.dms ?? 'NIP-17') }),
      t('channels.list.nostrGroups', { count: Number(s.groups ?? 0) }),
    ];
  }
  const n = agentsOn(c.config.name, agents).length;
  const chats = channelChats(c).length;
  return [
    c.config.name,
    c.status === 'connecting' ? t('channels.list.connecting') : transportOf(c),
    t('channels.list.agents', { count: n }),
    chats > 0 && t('channels.list.chats', { count: chats }),
  ].filter(Boolean) as MetaItem[];
};

const ChannelRow = ({
  c,
  agents,
  active,
  panic,
}: {
  c: ChannelView;
  agents?: AgentView[];
  active: boolean;
  panic: boolean;
}) => {
  const lamp = channelLampWithPanic(c, panic);
  const relays = c.config.provider === 'nostr' ? relayHealth([c]) : undefined;
  const title = channelTitle(c);
  return (
    <li className={cx('border-b border-line last:border-b-0', active && 'bg-flare-wash')}>
      <Link
        href={`/channels/${c.config.name}`}
        aria-current={active ? 'page' : undefined}
        className="flex min-h-16 items-center gap-3 px-4 py-3 outline-none data-[hovered]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus"
      >
        <LetterTile code={providerMonogram(c.config.provider)} className="mt-0.5 self-start" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate type-title-3 text-ink">{title}</span>
            {relays && c.status === 'connected' ? (
              <span className="flex shrink-0 items-center gap-2">
                <StatusDot state={lamp} hideLabel />
                <SignalBars
                  up={relays.up}
                  total={relays.total}
                  unit="relays"
                  limit={relays.up < relays.total}
                />
              </span>
            ) : (
              <StatusDot state={lamp} className="shrink-0" />
            )}
          </span>
          <MetaLine items={channelSlug(c, agents)} />
        </span>
        <CaretRight size={16} className="shrink-0 text-ink-3" aria-hidden="true" />
      </Link>
      {c.status === 'error' && c.config.secretRefs.length > 0 && (
        <div className="-mt-2 flex pb-2 pl-[3.25rem]">
          <Link
            href={`/channels/${c.config.name}?replace=1`}
            className="inline-flex min-h-11 items-center gap-1 px-1 type-label text-stop-text underline-offset-[3px] outline-none data-[hovered]:underline data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
          >
            {t('channels.list.replace')}
            <span className="sr-only"> {t('channels.list.replaceFor', { name: title })}</span>
            <CaretRight size={14} aria-hidden="true" />
          </Link>
        </div>
      )}
    </li>
  );
};

export const ChannelsScreen = () => {
  const hasDetail = useHasDetail('/channels');
  const q = useApi('channel.list');
  const agents = useApi('agent.list');
  const providers = useApi('channel.providers');
  const { panic } = usePanicState();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const showSkeleton = useDelayedLoading(q.isPending);
  const drafts = useDrafts(Object.keys(DEFAULT_STEPS));
  const channels = q.data?.channels ?? [];
  const attention = channels.filter(needsAttention);
  const ok = channels.filter((c) => !needsAttention(c));
  const isActive = (c: ChannelView) => pathname === `/channels/${c.config.name}`;
  const stepsOf = (p: string) =>
    normalizeSteps(p, providers.data?.providers.find((x) => x.provider === p)?.steps);

  const group = (id: string, label: string, list: ChannelView[]) =>
    list.length > 0 && (
      <section aria-labelledby={id}>
        <Eyebrow id={id} count={list.length}>
          {label}
        </Eyebrow>
        <ul className="overflow-hidden rounded-lg border border-line bg-surface">
          {list.map((c) => (
            <ChannelRow
              key={c.config.name}
              c={c}
              agents={agents.data?.agents}
              active={isActive(c)}
              panic={panic}
            />
          ))}
        </ul>
      </section>
    );

  return (
    <SplitView
      hasDetail={hasDetail}
      empty={
        <EmptyPane
          title={t('empty.channels.title')}
          body={t('empty.channels.body')}
          action={
            <LinkButton href="/channels/add" variant="primary" size="sm">
              {t('empty.channels.action')}
            </LinkButton>
          }
        />
      }
      list={
        <Screen
          title={t('nav.channels')}
          pane="list"
          slug={
            q.data && (
              <MetaLine
                items={[
                  t('channels.list.slugCount', { count: channels.length }),
                  attention.length > 0
                    ? { value: t('channels.list.slugAttention', { count: attention.length }), tone: 'stop' }
                    : { value: t('channels.list.slugAllOk'), tone: 'go' },
                ]}
              />
            )
          }
          actions={
            <BarAction
              href="/channels/add"
              label={t('channels.list.add')}
              ariaLabel={t('channels.list.addLabel')}
              icon={<Plus size={20} weight="bold" aria-hidden="true" />}
            />
          }
        >
          <div className="flex flex-col gap-5">
            {drafts.length > 0 && (
              <section aria-labelledby="ch-resume">
                <Eyebrow id="ch-resume" count={drafts.length}>
                  {t('channels.add.unfinished')}
                </Eyebrow>
                <ul className="overflow-hidden rounded-lg border border-line bg-flare-wash">
                  {drafts.map((d) => (
                    <ResumeRow key={d.provider} d={d} steps={stepsOf(d.provider)} />
                  ))}
                </ul>
              </section>
            )}
            {q.isPending ? (
              showSkeleton ? (
                <Skeleton variant="list" count={4} label={t('channels.list.loading')} />
              ) : null
            ) : q.error && !q.data ? (
              <ErrorState title={t('channels.list.error')} details={q.error} onRetry={() => void q.refetch()}>
                {t('channels.list.errorBody')}
              </ErrorState>
            ) : channels.length === 0 ? (
              <EmptyState
                glyph={<Plugs size={32} aria-hidden="true" />}
                title={t('channels.list.emptyTitle')}
                action={
                  <LinkButton href="/channels/add" variant="primary">
                    {t('channels.list.emptyAction')}
                  </LinkButton>
                }
                cli="beamhop channel add telegram"
              >
                {t('channels.list.emptyBody')}
              </EmptyState>
            ) : (
              <>
                {group('ch-attention', t('channels.list.attention'), attention)}
                {group('ch-ok', attention.length ? t('channels.list.others') : t('channels.list.all'), ok)}
              </>
            )}
            {channels.length > 0 && <CliStrip command="beamhop channel list" />}
          </div>
        </Screen>
      }
    >
      <Outlet />
    </SplitView>
  );
};
