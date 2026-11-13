/**
 * Desktop status strip: one mono line across the top of the main area — daemon, link, panic state,
 * relay health. Like the header row of an instrument panel. Compact shows the same info in the top bar.
 */
import { Button as RACButton } from 'react-aria-components';
import { useApi, useDaemons } from '../api/index.ts';
import { t } from '../i18n/index.ts';
import { since } from '../lib/format.ts';
import { Badge, Kbd } from '../ui/Meta.tsx';
import { StatusDot } from '../ui/Status.tsx';
import { useConnectionSummary } from './Connection.tsx';
import { modKey, openOverlay } from './overlays.ts';
import { usePanicState } from './panic.tsx';

export const StatusStrip = () => {
  const { conn, relays, link } = useConnectionSummary();
  const { active } = useDaemons();
  const connected = link === 'reachable' || link === 'no-answer';
  const status = useApi('system.status', undefined, { refetchInterval: 30_000, enabled: connected });
  const { panic } = usePanicState();
  const s = status.data;
  const via =
    conn.kind === 'mock'
      ? t('strip.via.demo')
      : conn.kind === 'nostr'
        ? t('strip.via.hosted', { name: active?.name ?? '' })
        : conn.kind === 'local'
          ? t('strip.via.local')
          : t('conn.link.not-paired');
  const healthy = link === 'reachable';
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-4 border-b border-line px-8 type-micro text-ink-3"
      data-status-strip=""
    >
      <span className="flex items-center gap-2">
        <span className="text-ink-2">beamhopd {s?.version ?? '—'}</span>
        <span aria-hidden="true">·</span>
        <span>{via}</span>
        {s && (
          <>
            <span aria-hidden="true">·</span>
            <span>{t('strip.up', { time: since(Date.now() - s.uptimeSec * 1000) })}</span>
          </>
        )}
      </span>
      <span className="flex items-center gap-2">
        <StatusDot
          state={panic ? 'panic' : healthy ? 'ready' : link === 'no-answer' ? 'needs-you' : 'offline'}
          label={panic ? t('strip.panic') : t(`conn.link.${link}`)}
        />
      </span>
      {relays && <span>{t('strip.relays', { up: relays.up, total: relays.total })}</span>}
      {s && (
        <span>
          {t('strip.counts', { agents: s.agents, channels: s.channels, pending: s.pendingApprovals })}
        </span>
      )}
      <span className="ml-auto flex items-center gap-3">
        {conn.kind === 'mock' && <Badge tone="flare">{t('strip.demo')}</Badge>}
        <RACButton
          onPress={() => openOverlay('palette')}
          className="flex items-center gap-1.5 rounded-sm px-1 normal-case tracking-normal outline-none data-[hovered]:text-ink data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
        >
          <Kbd>{`${modKey()}K`}</Kbd>
          <span className="type-meta">{t('strip.search')}</span>
        </RACButton>
        <RACButton
          onPress={() => openOverlay('shortcuts')}
          aria-label={t('keys.title')}
          className="flex items-center rounded-sm px-1 outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
        >
          <Kbd>?</Kbd>
        </RACButton>
      </span>
    </div>
  );
};
