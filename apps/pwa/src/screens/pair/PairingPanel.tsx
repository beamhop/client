/**
 * Computer (trusted) side of device pairing — JOURNEYS §1.04 and §9 steps 1 & 3.
 * Used by onboarding step 04 and Settings → Devices → Pair a device.
 *
 * QR (link with the one-time token in the fragment) + Doto expiry countdown + `Show code instead` +
 * `Copy link`, the 4-word safety phrase the phone will show, and a live wait for the phone: we poll
 * `device.list` and resolve as soon as a device that wasn't there before appears.
 *
 * TODO(core): JOURNEYS §9.3 wants the final "Yes, pair" on the computer. The API has no
 * `device.pairConfirm`; today the phone confirms the match and calls `device.pairComplete`.
 */
import type { DeviceView } from '@beamhop/core';
import { ArrowClockwise, Check, Copy, DeviceMobile, QrCode as QrIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi, useBeamhop, useCall } from '../../api/index.ts';
import { cx } from '../../lib/cx.ts';
import { countdown } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { announce } from '../../lib/live.ts';
import { useNow } from '../../lib/useNow.ts';
import { Button } from '../../ui/Button.tsx';
import { Readout } from '../../ui/Meta.tsx';
import { QrCode } from '../../ui/QrCode.tsx';
import { ErrorState, Skeleton } from '../../ui/States.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { tokenFromUri, useSafetyPhrase } from './safetyPhrase.ts';

/** Four words, numbered, big mono caps. Screen readers get one sentence. */
export const SafetyPhrase = ({
  words,
  size = 'md',
  className,
}: {
  words?: string[];
  size?: 'md' | 'lg';
  className?: string;
}) => (
  <div className={className}>
    {words ? (
      <>
        <p className="sr-only">Safety phrase: {words.join(', ')}.</p>
        <ol aria-hidden="true" className="grid grid-cols-2 gap-x-4 gap-y-2 medium:grid-cols-4">
          {words.map((w, i) => (
            <li key={`${w}-${i}`} className="flex items-baseline gap-2 border-b border-line pb-1.5">
              <span className="type-micro text-ink-3">{i + 1}</span>
              <span
                className={cx(
                  'font-mono font-semibold tracking-[0.04em] text-ink',
                  size === 'lg' ? 'text-[22px] leading-8' : 'text-[17px] leading-6',
                )}
                style={{ fontVariationSettings: '"wdth" 87.5' }}
              >
                {w}
              </span>
            </li>
          ))}
        </ol>
      </>
    ) : (
      <div aria-hidden="true" className="grid grid-cols-2 gap-3 medium:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="h-7 rounded-sm border border-line" />
        ))}
      </div>
    )}
  </div>
);

export interface PairingPanelProps {
  onPaired?: (d: DeviceView) => void;
  /** Smaller QR inside sheets. */
  compact?: boolean;
  className?: string;
}

const STEPS = ['Scan with your phone camera', 'Check the 4 words match', 'Allow notifications'];

export const PairingPanel = ({ onPaired, compact, className }: PairingPanelProps) => {
  const now = useNow(1000);
  const call = useCall();
  const { mock } = useBeamhop();
  const start = useApi(
    'device.pairStart',
    { name: 'New device' },
    { staleTime: Number.POSITIVE_INFINITY, gcTime: 0, refetchOnWindowFocus: false, retry: false },
  );
  const [showCode, setShowCode] = useState(false);
  const [paired, setPaired] = useState<DeviceView>();
  const [copied, setCopied] = useState(false);
  const known = useRef<Set<string> | null>(null);
  const expiresAt = start.data ? new Date(start.data.expiresAt).getTime() : 0;
  const left = expiresAt - now;
  const expired = !!start.data && left <= 0;
  const devices = useApi('device.list', undefined, {
    refetchInterval: paired || expired ? false : 2000,
  });

  // Remember devices that existed when the code was issued; any new one is "the phone".
  useEffect(() => {
    if (!devices.data) return;
    if (!known.current) {
      known.current = new Set(devices.data.devices.map((d) => d.id));
      return;
    }
    if (paired) return;
    const fresh = devices.data.devices.find((d) => !known.current!.has(d.id));
    if (fresh) {
      setPaired(fresh);
      haptic('confirm');
      announce(`Paired ${fresh.name}.`);
      onPaired?.(fresh);
    }
  }, [devices.data, paired, onPaired]);

  const secret = start.data ? (showCode ? start.data.code : tokenFromUri(start.data.uri)) : undefined;
  const words = useSafetyPhrase(secret);
  const qrSize = compact ? 200 : 240;

  const steps = useMemo(
    () =>
      STEPS.map((s, i) => (
        <li key={s} className="flex items-start gap-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-full border border-line-strong font-mono text-[11px] text-ink-2">
            {i + 1}
          </span>
          <span className="pt-0.5 type-body-sm text-ink">{s}</span>
        </li>
      )),
    [],
  );

  if (start.isError) {
    return (
      <ErrorState
        title="Couldn't start pairing."
        details={start.error}
        onRetry={() => void start.refetch()}
        className={className}
      >
        {start.error.message}
      </ErrorState>
    );
  }
  if (!start.data) return <Skeleton variant="detail" count={1} label="Preparing a pairing code" />;

  if (paired) {
    return (
      <div className={cx('flex flex-col gap-3 rounded-lg border border-line bg-go-wash p-4', className)}>
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-md bg-surface text-go-text">
            <Check size={22} weight="bold" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="type-title-3 text-ink">Paired · {paired.name}</p>
            <p className="type-meta text-ink-2">
              {paired.pushEnabled ? 'notifications on' : 'notifications not on yet'} · key{' '}
              {paired.pubkey.slice(0, 12)}…
            </p>
          </div>
        </div>
        <p className="type-body-sm text-ink-2">
          It can now approve requests and stop agents. Remove it any time in Settings → Devices.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cx(
        'flex flex-col gap-5 expanded:grid expanded:grid-cols-[auto_1fr] expanded:items-start expanded:gap-8',
        className,
      )}
    >
      <div className="flex flex-col items-start gap-3">
        <div className="relative">
          {showCode ? (
            <div
              className="grid place-items-center rounded-md border border-line bg-surface"
              style={{ width: qrSize, height: qrSize }}
            >
              <div className="text-center">
                <p className="type-micro text-ink-2">Pairing code</p>
                <p
                  className="mt-2 font-mono text-[28px] leading-9 font-semibold tracking-[0.08em] text-ink select-all"
                  aria-label={`Pairing code ${start.data.code.split('').join(' ')}`}
                >
                  {start.data.code}
                </p>
                <p className="mt-1 type-meta text-ink-2">Open beamhop on the phone → Enter code</p>
              </div>
            </div>
          ) : (
            <QrCode
              value={start.data.uri}
              size={qrSize}
              label="QR code to pair your phone. Scan it with the phone's camera."
            />
          )}
          {expired && (
            <div className="absolute inset-0 grid place-items-center rounded-md bg-bg/85">
              <span aria-hidden="true" className="hatch absolute inset-0 rounded-md text-ink-3" />
              <Button
                variant="primary"
                icon={<ArrowClockwise size={16} weight="bold" aria-hidden="true" />}
                onPress={() => {
                  known.current = null;
                  void start.refetch();
                }}
              >
                Get a new code
              </Button>
            </div>
          )}
        </div>
        <div className="flex items-baseline gap-3" aria-live="off">
          <span className="type-meta text-ink-2">{expired ? 'Expired' : 'Expires in'}</span>
          <Readout size="md" tone={expired ? 'stop' : left < 30_000 ? 'caution' : 'ink'}>
            {countdown(Math.max(0, left))}
          </Readout>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            variant="secondary"
            size="sm"
            icon={showCode ? <QrIcon size={16} aria-hidden="true" /> : undefined}
            onPress={() => setShowCode((v) => !v)}
          >
            {showCode ? 'Show QR instead' : 'Show code instead'}
          </Button>
          <Button
            variant="quiet"
            size="sm"
            icon={
              copied ? (
                <Check size={16} weight="bold" className="text-go-text" aria-hidden="true" />
              ) : (
                <Copy size={16} aria-hidden="true" />
              )
            }
            onPress={async () => {
              try {
                await navigator.clipboard.writeText(start.data.uri);
              } catch {
                /* blocked: the QR still works */
              }
              setCopied(true);
              announce('Pairing link copied.');
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <ol className="flex flex-col gap-3">{steps}</ol>
        <section aria-labelledby="pair-phrase" className="flex flex-col gap-2.5">
          <h3 id="pair-phrase" className="type-micro text-ink-2">
            Your phone will show
          </h3>
          <SafetyPhrase words={words} />
          <p className="type-body-sm text-ink-2">
            If the words differ, don't confirm on the phone. Someone else's code may have been swapped in.
          </p>
        </section>
        <div className="flex items-center gap-2" role="status">
          <StatusDot state={expired ? 'stopped' : 'needs-you'} label={expired ? 'expired' : 'waiting'} />
          <span className="type-body-sm text-ink-2">
            {expired ? 'This code expired. Get a new one.' : 'Waiting for your phone…'}
          </span>
        </div>
        {mock && !expired && (
          <Button
            variant="quiet"
            size="sm"
            className="-ml-3 self-start"
            icon={<DeviceMobile size={16} aria-hidden="true" />}
            onPress={() =>
              void call('device.pairComplete', {
                code: start.data.code,
                pubkey: `demo-${Math.random().toString(16).slice(2, 14)}`,
                name: 'Demo phone · Safari',
              }).then(() => void devices.refetch())
            }
          >
            Demo: pair a test phone
          </Button>
        )}
      </div>
    </div>
  );
};
