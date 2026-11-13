/**
 * Connection pill (DESIGN §9.2) + Connection sheet, for every transport:
 *  - mock: hop meter of the demo Nostr relays + DEMO badge.
 *  - local: relays of the daemon's Nostr channel; the daemon is this computer.
 *  - nostr (hosted): relays this browser holds open to reach the daemon, daemon reachability
 *    (reachable / no answer / unpaired), requests queued while offline; "Pair again" when the daemon
 *    no longer knows this device; "Disconnect this browser" removes the device there and forgets it here.
 *  - none: not paired yet → "Pair this browser".
 * Reconnecting shows in the pill only (no banner for <10 s, DESIGN §10).
 */
import { CellTower, DeviceMobile, Laptop, LinkBreak, Plugs } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button as RACButton } from 'react-aria-components';
import {
  forgetToken,
  type LampState,
  relayHealth,
  useApi,
  useCall,
  useConnection,
  useDaemons,
} from '../api/index.ts';
import { t } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';
import { ago, middleTruncate, since } from '../lib/format.ts';
import { Button, LinkButton } from '../ui/Button.tsx';
import { Badge, Eyebrow } from '../ui/Meta.tsx';
import { ConfirmDialog, Sheet } from '../ui/Sheet.tsx';
import { SignalBars, StatusDot } from '../ui/Status.tsx';

export type DaemonLink = 'reachable' | 'connecting' | 'no-answer' | 'unpaired' | 'not-paired' | 'offline';

export const useConnectionSummary = () => {
  const conn = useConnection();
  const hosted = conn.kind === 'nostr' ? conn.hosted : undefined;
  const channels = useApi('channel.list', undefined, {
    enabled: conn.status === 'open' && (conn.kind === 'mock' || conn.kind === 'local'),
  });
  const relays = hosted
    ? hosted.total > 0
      ? { up: hosted.up, total: hosted.total }
      : undefined
    : relayHealth(channels.data?.channels);
  const offline =
    conn.kind !== 'none' && (!conn.online || (conn.status === 'closed' && hosted?.daemon !== 'unpaired'));
  const connecting = conn.status === 'connecting';
  const link: DaemonLink =
    conn.kind === 'none'
      ? 'not-paired'
      : hosted?.daemon === 'unpaired'
        ? 'unpaired'
        : offline
          ? 'offline'
          : connecting
            ? 'connecting'
            : hosted?.daemon === 'unreachable'
              ? 'no-answer'
              : 'reachable';
  return { conn, hosted, relays, offline, connecting, link, queued: hosted?.queued ?? 0 };
};

const LINK_LAMP: Record<DaemonLink, LampState> = {
  reachable: 'ready',
  connecting: 'paused',
  'no-answer': 'needs-you',
  unpaired: 'error',
  'not-paired': 'stopped',
  offline: 'offline',
};
const linkWord = (l: DaemonLink) => t(`conn.link.${l}`);

export const ConnectionPill = ({ className, wide }: { className?: string; wide?: boolean }) => {
  const [open, setOpen] = useState(false);
  const { conn, relays, offline, connecting, link, queued } = useConnectionSummary();
  // Problems are words (shape + word, DESIGN §3.3); a healthy link is just the hop meter.
  const problem = link === 'not-paired' || link === 'unpaired' || link === 'offline' || link === 'no-answer';
  return (
    <>
      <RACButton
        onPress={() => setOpen(true)}
        className={cx(
          'inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-2 type-meta text-ink-2 outline-none data-[hovered]:bg-sunken data-[pressed]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus',
          className,
        )}
        data-connection={offline ? 'offline' : connecting ? 'connecting' : link}
      >
        <span className="sr-only">{t('conn.pill.prefix')} </span>
        {problem ? (
          <StatusDot state={LINK_LAMP[link]} label={linkWord(link)} />
        ) : (
          <>
            <SignalBars
              up={connecting ? 0 : (relays?.up ?? 1)}
              total={relays?.total ?? 4}
              busy={connecting}
              hideNumber={!relays}
              unit={relays && wide ? t('conn.relaysUnit') : undefined}
            />
            {relays && !wide && <span className="sr-only">{t('conn.relaysUnit')}</span>}
            {!relays && (
              <span className={connecting ? undefined : 'sr-only'}>
                {connecting ? t('conn.connecting') : conn.kind === 'local' ? t('conn.local') : t('conn.demo')}
              </span>
            )}
          </>
        )}
        {queued > 0 && <span className="text-caution-text">{t('conn.queued', { count: queued })}</span>}
        {conn.kind === 'mock' && <Badge tone="flare">{t('conn.demo')}</Badge>}
        <span className="sr-only">{t('conn.pill.suffix')}</span>
      </RACButton>
      <ConnectionSheet isOpen={open} onOpenChange={setOpen} />
    </>
  );
};

const Row = ({ term, children }: { term: string; children: React.ReactNode }) => (
  <>
    <dt className="text-ink-2">{term}</dt>
    <dd className="min-w-0 text-ink">{children}</dd>
  </>
);

export const ConnectionSheet = ({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
}) => {
  const { conn, hosted, relays, offline, link, queued } = useConnectionSummary();
  const reachable = conn.kind !== 'none' && link !== 'unpaired';
  const status = useApi('system.status', undefined, { enabled: isOpen && reachable });
  const channels = useApi('channel.list', undefined, {
    enabled: isOpen && (conn.kind === 'mock' || conn.kind === 'local'),
  });
  const { active, daemons, switchTo, remove } = useDaemons();
  const call = useCall();
  const [confirm, setConfirm] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Relay rows: hosted = the browser's own relay sockets; local/mock = the daemon's Nostr channel.
  const nostr = channels.data?.channels.find((c) => c.config.provider === 'nostr');
  const daemonRelays = (nostr?.config.settings.relays as string[] | undefined) ?? [];
  const up = new Set((nostr?.config.settings.relaysUp as string[] | undefined) ?? daemonRelays);
  const relayRows = hosted
    ? hosted.relays.map((r) => ({ url: r.url, ok: r.connected, error: r.lastError }))
    : daemonRelays.map((url) => ({ url, ok: up.has(url), error: undefined as string | undefined }));

  const disconnect = async () => {
    setLeaving(true);
    if (conn.kind === 'nostr' && active) {
      // Remove this device on the daemon first (best effort: it may be unreachable or already gone),
      // then forget the daemon here. Removing the active daemon reloads into the next one / pairing.
      if (active.deviceId && link === 'reachable')
        await call('device.remove', { id: active.deviceId }).catch(() => undefined);
      remove(active.id);
      return;
    }
    forgetToken();
    window.location.assign('/');
  };

  const subtitle =
    conn.kind === 'mock'
      ? t('conn.sheet.demo')
      : conn.kind === 'local'
        ? `beamhopd · ${conn.baseUrl ?? ''}`
        : conn.kind === 'nostr'
          ? t('conn.sheet.hosted', { name: active?.name ?? '' })
          : t('conn.sheet.none');

  return (
    <Sheet isOpen={isOpen} onOpenChange={onOpenChange} title={t('conn.sheet.title')} subtitle={subtitle}>
      <div className="flex flex-col gap-6">
        {conn.kind === 'none' ? (
          <div className="flex flex-col gap-3">
            <p className="type-body text-ink-2">{t('conn.none.body')}</p>
            <LinkButton href="/pair" variant="primary" icon={<DeviceMobile size={18} aria-hidden="true" />}>
              {t('conn.none.pair')}
            </LinkButton>
          </div>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 type-meta">
            <Row term={t('conn.row.daemon')}>
              <span className="flex items-center gap-2">
                {conn.kind === 'mock' ? (
                  <Plugs size={14} aria-hidden="true" />
                ) : (
                  <Laptop size={14} aria-hidden="true" />
                )}
                <span className="truncate">
                  {conn.kind === 'mock'
                    ? t('conn.row.demoDaemon')
                    : conn.kind === 'nostr'
                      ? (active?.name ?? '—')
                      : `beamhopd ${status.data?.version ?? ''}`}
                </span>
              </span>
            </Row>
            <Row term={t('conn.row.link')}>
              <StatusDot state={LINK_LAMP[link]} label={linkWord(link)} />
            </Row>
            {hosted && (
              <>
                <Row term={t('conn.row.daemonKey')}>
                  <span title={hosted.daemonNpub}>{middleTruncate(hosted.daemonNpub, 22)}</span>
                </Row>
                {hosted.identity && (
                  <Row term={t('conn.row.thisBrowser')}>
                    <span title={hosted.identity.npub}>
                      {middleTruncate(hosted.identity.npub, 22)} · {t(`conn.signer.${hosted.identity.kind}`)}
                    </span>
                  </Row>
                )}
                {hosted.daemonSeenAt && <Row term={t('conn.row.lastAnswer')}>{ago(hosted.daemonSeenAt)}</Row>}
                {queued > 0 && <Row term={t('conn.row.queued')}>{t('conn.queued', { count: queued })}</Row>}
                {hosted.error && <Row term={t('conn.row.problem')}>{hosted.error}</Row>}
              </>
            )}
            {status.data && (
              <>
                <Row term={t('conn.row.uptime')}>{since(Date.now() - status.data.uptimeSec * 1000)}</Row>
                <Row term={t('conn.row.home')}>{status.data.home}</Row>
              </>
            )}
          </dl>
        )}

        {link === 'unpaired' && (
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-stop-wash p-4">
            <p className="flex items-start gap-2 type-body-sm text-ink">
              <LinkBreak size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-stop-text" />
              {t('conn.unpaired.body', { name: active?.name ?? '' })}
            </p>
            <LinkButton href="/pair" variant="primary" className="self-start">
              {t('conn.unpaired.pair')}
            </LinkButton>
          </div>
        )}
        {link === 'no-answer' && <p className="type-body-sm text-ink-2">{t('conn.noAnswer.body')}</p>}

        {relays && relayRows.length > 0 && (
          <section aria-labelledby="conn-relays">
            <Eyebrow
              id="conn-relays"
              action={<SignalBars up={relays.up} total={relays.total} unit={t('conn.up')} />}
            >
              {hosted ? t('conn.relays.hosted') : t('conn.relays.daemon')}
            </Eyebrow>
            <ul className="mt-1 divide-y divide-line rounded-lg border border-line">
              {relayRows.map((r) => (
                <li key={r.url} className="flex min-h-11 items-center gap-3 px-3 py-2 type-meta text-ink">
                  <CellTower size={16} aria-hidden="true" className="shrink-0 text-ink-2" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{r.url.replace(/^wss?:\/\//, '')}</span>
                    {!r.ok && r.error && <span className="truncate text-ink-2">{r.error}</span>}
                  </span>
                  <StatusDot
                    state={r.ok ? 'ready' : 'offline'}
                    label={r.ok ? t('conn.relay.ok') : t('conn.relay.down')}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        {conn.kind === 'nostr' && daemons.length > 1 && (
          <section aria-labelledby="conn-daemons" className="flex flex-col gap-1">
            <Eyebrow id="conn-daemons">{t('conn.daemons')}</Eyebrow>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {daemons.map((d) => (
                <li key={d.id} className="flex min-h-12 items-center gap-3 px-3">
                  <Laptop size={18} aria-hidden="true" className="shrink-0 text-ink-2" />
                  <span className="min-w-0 flex-1 truncate type-body-sm text-ink">{d.name}</span>
                  {d.id === active?.id ? (
                    <Badge tone="outline">{t('conn.daemons.current')}</Badge>
                  ) : (
                    <Button variant="quiet" size="sm" onPress={() => switchTo(d.id)}>
                      {t('conn.daemons.switch')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {offline && conn.kind !== 'mock' && <p className="type-body-sm text-ink-2">{t('offline.banner')}</p>}

        {conn.kind === 'mock' ? (
          <p className="type-body-sm text-ink-2">
            {t('conn.mock.body')} <code className="font-mono text-[0.875em] text-ink">beamhop ui</code>
          </p>
        ) : conn.kind !== 'none' ? (
          <Button variant="destructive-outline" className="self-start" onPress={() => setConfirm(true)}>
            {t('conn.disconnect')}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        isOpen={confirm}
        onOpenChange={setConfirm}
        title={t('conn.disconnect.title')}
        confirmLabel={t('conn.disconnect')}
        isPending={leaving}
        onConfirm={disconnect}
      >
        {conn.kind === 'nostr'
          ? t('conn.disconnect.hosted', { name: active?.name ?? '' })
          : t('conn.disconnect.local')}
      </ConfirmDialog>
    </Sheet>
  );
};
