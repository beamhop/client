/**
 * Owner pairing (JOURNEYS §4 step 5, DESIGN §12 "3.3.8 Accessible Authentication").
 * Telegram: one deep link `t.me/{bot}?start=pair-{code}` so nobody types a code; a QR of the same
 * link on desktop (scan with the phone that has Telegram); manual `/pair CODE` with copy as fallback.
 * Slack / Discord: `/pair CODE` with copy + Open Slack/Discord. Waits on live `channel.updated`
 * events, then asks the owner to confirm the paired account ("This is me" / "Not me — unpair").
 */
import type { ChannelView } from '@beamhop/core';
import { ArrowClockwise, CheckCircle, ShieldWarning } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCall } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { countdown } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { announce } from '../../lib/live.ts';
import { useExpanded } from '../../lib/media.ts';
import { useNow } from '../../lib/useNow.ts';
import { Button } from '../../ui/Button.tsx';
import { CopyButton } from '../../ui/CliStrip.tsx';
import { Readout } from '../../ui/Meta.tsx';
import { QrCode } from '../../ui/QrCode.tsx';
import { ErrorState } from '../../ui/States.tsx';
import { ExternalButton, WaitingLine } from './parts.tsx';
import { channelPairings, type Pairing, SLACK_OPEN_URL, telegramStartLink } from './providers.ts';

export interface PairCode {
  code: string;
  expiresAt: string;
  issuedAt: string;
}

export interface PairPanelProps {
  channel: ChannelView;
  /** A code issued earlier (wizard draft), re-used until it expires. */
  initial?: PairCode;
  onCode?: (c: PairCode) => void;
  /** The owner confirmed the paired account. */
  onConfirmed: (p: Pairing) => void;
  /** Hide the "This is me" button when the host renders its own Continue. */
  confirmLabel?: string;
}

const providerWord = (p: string) => ({ telegram: 'Telegram', slack: 'Slack', discord: 'Discord' })[p] ?? p;

export const PairPanel = ({
  channel,
  initial,
  onCode,
  onConfirmed,
  confirmLabel,
  bot: botHint,
}: PairPanelProps & { bot?: string }) => {
  const call = useCall();
  const now = useNow(1000);
  const expanded = useExpanded();
  const [code, setCode] = useState<PairCode | undefined>(() =>
    initial && new Date(initial.expiresAt).getTime() > Date.now() ? initial : undefined,
  );
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [unpairing, setUnpairing] = useState(false);
  const provider = channel.config.provider;
  const bot = channel.self?.handle ?? botHint ?? channel.self?.displayName ?? channel.config.name;
  const word = providerWord(provider);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  const issue = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await call('channel.pair', { name: channel.config.name });
      const c = { code: r.code, expiresAt: r.expiresAt, issuedAt: new Date().toISOString() };
      setCode(c);
      onCodeRef.current?.(c);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: issue once per channel when no valid code exists
  useEffect(() => {
    if (!code) void issue();
  }, [channel.config.name]);

  /** A pairing that arrived after this code was issued (and wasn't rejected). */
  const paired = useMemo(() => {
    if (!code) return undefined;
    const since = new Date(code.issuedAt).getTime() - 2000;
    return channelPairings(channel)
      .filter((p) => !rejected.includes(p.principal) && new Date(p.pairedAt).getTime() >= since)
      .at(-1);
  }, [channel, code, rejected]);

  const announced = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (paired && announced.current !== paired.principal) {
      announced.current = paired.principal;
      haptic('confirm');
      announce(t('channels.pair.pairedSpoken', { who: paired.handle ?? paired.displayName, provider: word }));
    }
  }, [paired, word]);

  if (error)
    return (
      <ErrorState title={t('channels.pair.errorTitle')} details={error} onRetry={() => void issue()}>
        {error.message}
      </ErrorState>
    );

  const left = code ? new Date(code.expiresAt).getTime() - now : 0;
  const expired = !!code && left <= 0;
  const deepLink = provider === 'telegram' && code ? telegramStartLink(bot, code.code) : undefined;
  const command = code ? `/pair ${code.code}` : '/pair ····-····';

  if (paired) {
    const id = paired.principal.slice(paired.principal.indexOf(':') + 1);
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-lg border border-line bg-go-wash px-4 py-3.5">
          <CheckCircle size={24} weight="fill" className="mt-0.5 shrink-0 text-go-text" aria-hidden="true" />
          <div className="min-w-0">
            <p className="type-title-3 text-ink">
              {t('channels.pair.paired', { who: paired.handle ?? paired.displayName })}
            </p>
            <p className="type-meta text-ink-2">
              {word} {id} · {t('channels.pair.asOwner')}
            </p>
          </div>
        </div>
        <p className="type-body-sm text-ink-2">{t('channels.pair.confirmHint')}</p>
        <div className="flex flex-col gap-2 medium:flex-row">
          <Button variant="primary" size="lg" onPress={() => onConfirmed(paired)} className="medium:flex-1">
            {confirmLabel ?? t('channels.pair.thisIsMe')}
          </Button>
          <Button
            variant="destructive-outline"
            size="lg"
            isPending={unpairing}
            onPress={async () => {
              setUnpairing(true);
              try {
                await call('owner.remove', { principal: paired.principal }).catch(() => undefined);
                await call('role.revoke', { principal: paired.principal });
                setRejected((r) => [...r, paired.principal]);
                announce(t('channels.pair.unpairedSpoken'));
                await issue();
              } finally {
                setUnpairing(false);
              }
            }}
          >
            {t('channels.pair.notMe')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {deepLink && !expired && (
        <div className="flex flex-col gap-3">
          <ExternalButton href={deepLink} variant="primary" fullWidth>
            {t('channels.pair.openBot', { bot, provider: word })}
          </ExternalButton>
          {expanded && (
            <div className="flex items-center gap-4 rounded-lg border border-line bg-surface p-3">
              <QrCode value={deepLink} label={t('channels.pair.qrLabel', { bot })} size={132} />
              <p className="type-body-sm text-ink-2">{t('channels.pair.qrHint')}</p>
            </div>
          )}
        </div>
      )}
      {!deepLink && !expired && provider === 'slack' && (
        <ExternalButton href={SLACK_OPEN_URL} variant="primary" fullWidth>
          {t('channels.pair.openSlack')}
        </ExternalButton>
      )}

      <div className="flex flex-col gap-2">
        <p className="type-label text-ink">
          {deepLink
            ? t('channels.pair.orSend')
            : provider === 'slack'
              ? t('channels.pair.send.slack', { bot })
              : provider === 'discord'
                ? t('channels.pair.send.discord', { bot })
                : t('channels.pair.send.other', { bot })}
        </p>
        <div
          className={`flex items-center gap-2 rounded-lg border border-line bg-sunken py-2 pr-1 pl-4 ${expired ? 'opacity-50' : ''}`}
        >
          <span className="font-mono text-[15px] text-ink-2" aria-hidden="true">
            /pair
          </span>
          <Readout size="md" className="min-w-0 flex-1 truncate tracking-wide">
            <span className="sr-only">/pair </span>
            {code?.code ?? '····-····'}
          </Readout>
          {code && !expired && <CopyButton value={command} label={t('channels.pair.copy')} />}
        </div>
        <p className={`type-meta tabular-nums ${left < 120_000 ? 'text-caution-text' : 'text-ink-2'}`}>
          {!code
            ? t('channels.pair.issuing')
            : expired
              ? t('channels.pair.expired')
              : t('channels.pair.expiresIn', { time: countdown(left) })}
        </p>
      </div>

      {expired ? (
        <Button
          variant="secondary"
          size="lg"
          icon={<ArrowClockwise size={18} aria-hidden="true" />}
          isPending={busy}
          onPress={() => void issue()}
        >
          {t('channels.pair.newCode')}
        </Button>
      ) : (
        <WaitingLine>
          {t(provider === 'telegram' ? 'channels.pair.waitingTelegram' : 'channels.pair.waiting', {
            provider: word,
          })}
        </WaitingLine>
      )}

      <p className="flex items-start gap-2 type-body-sm text-ink-2">
        <ShieldWarning size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
        {t('channels.pair.safety')}
      </p>
    </div>
  );
};
