/**
 * Computer (trusted) side of device pairing — JOURNEYS §1.04 and §9 steps 1 & 3.
 * Used by onboarding step 04 and Settings → Devices → Pair a device.
 *
 * `device.pairStart({ requireConfirm: true })` → QR of the hosted pairing URL (payload in the fragment)
 * + Doto expiry countdown + `Show code instead` + `Copy link`. We poll `device.pairStatus`:
 * `waiting` → `awaiting-confirm` (the phone answered; the 4 words appear here) → the owner compares
 * and presses `Yes, pair iPhone · Safari` (`device.pairConfirm`) — confirmation happens on the trusted
 * side, which defends against swapped/relayed QR codes (linked-device phishing, MITRE T1676).
 * `No, cancel` rejects and the daemon logs a failed pairing (security event).
 */
import type { DeviceView, PairingStatusView } from '@beamhop/core';
import { ArrowClockwise, Check, Copy, QrCode as QrIcon, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useApi, useMutationApi } from '../../api/index.ts';
import { cx } from '../../lib/cx.ts';
import { countdown } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { announce } from '../../lib/live.ts';
import { useNow } from '../../lib/useNow.ts';
import { Button } from '../../ui/Button.tsx';
import { TicketCard } from '../../ui/Card.tsx';
import { Readout } from '../../ui/Meta.tsx';
import { QrCode } from '../../ui/QrCode.tsx';
import { ErrorState, Skeleton } from '../../ui/States.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { phraseWords } from './safetyPhrase.ts';

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
        <ol aria-hidden="true" className="grid grid-cols-2 gap-x-4 gap-y-2">
          {words.map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: words may repeat; position is identity
            <li key={`${w}-${i}`} className="flex min-w-0 items-baseline gap-2 border-b border-line pb-1.5">
              <span className="type-micro text-ink-3">{i + 1}</span>
              <span
                className={cx(
                  'truncate font-mono font-semibold tracking-[0.04em] text-ink',
                  size === 'lg' ? 'text-[21px] leading-8' : 'text-[17px] leading-6',
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
      <div aria-hidden="true" className="grid grid-cols-2 gap-x-4 gap-y-2">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="flex h-8 items-end gap-2 border-b border-dashed border-line-strong pb-1.5">
            <span className="type-micro text-ink-3">{i + 1}</span>
          </span>
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
  const start = useApi(
    'device.pairStart',
    { name: 'New device', requireConfirm: true },
    { staleTime: Number.POSITIVE_INFINITY, gcTime: 0, refetchOnWindowFocus: false, retry: false },
  );
  const pairingId = start.data?.pairingId ?? '';
  const [final, setFinal] = useState<PairingStatusView>();
  const status = useApi(
    'device.pairStatus',
    { pairingId },
    {
      enabled: !!pairingId && !final,
      refetchInterval: (q) => {
        const s = q.state.data?.status;
        return s === 'waiting' || s === undefined ? 1500 : false;
      },
    },
  );
  const confirm = useMutationApi('device.pairConfirm', { invalidate: ['device.list'] });
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const announced = useRef<string>(undefined);

  const current = final ?? status.data;
  const state = current?.status ?? 'waiting';
  const expiresAt = start.data ? new Date(start.data.expiresAt).getTime() : 0;
  const left = expiresAt - now;
  const expired = state === 'expired' || (state === 'waiting' && !!start.data && left <= 0);
  const words = phraseWords(current?.safetyPhrase);
  const device = current?.device;

  useEffect(() => {
    if (state === announced.current) return;
    announced.current = state;
    if (state === 'awaiting-confirm' && device) {
      haptic('tick');
      announce(`${device.name} answered. Check that it shows: ${words?.join(', ')}.`);
    }
  }, [state, device, words]);

  const restart = () => {
    setFinal(undefined);
    confirm.reset();
    void start.refetch();
  };

  const decide = async (accept: boolean) => {
    const r = await confirm.mutateAsync({ pairingId, accept });
    setFinal(r);
    if (accept && r.status === 'paired' && r.device) {
      haptic('confirm');
      announce(`Paired ${r.device.name}.`);
      onPaired?.(r.device);
    } else if (!accept) {
      haptic('reject');
      announce('Pairing cancelled. Nothing was paired.');
    }
  };

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

  if (state === 'paired' && device) {
    return (
      <div
        className={cx('flex flex-col gap-3 rounded-lg border border-line bg-go-wash p-4', className)}
        data-pairing="paired"
      >
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface text-go-text">
            <Check size={22} weight="bold" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="type-title-3 text-ink">Paired · {device.name}</p>
            <p className="type-meta text-ink-2">
              {device.pushEnabled ? 'notifications on' : 'notifications not on yet'} · phrase confirmed
            </p>
          </div>
        </div>
        <p className="type-body-sm text-ink-2">
          It can approve requests and stop agents now. Remove it any time in Settings → Devices.
        </p>
      </div>
    );
  }

  if (state === 'rejected') {
    return (
      <div className={cx('flex flex-col items-start gap-3', className)} data-pairing="rejected">
        <StatusDot state="stopped" label="cancelled" />
        <p className="type-title-3 text-ink">Pairing cancelled. Nothing was paired.</p>
        <p className="type-body-sm text-ink-2">
          The code can't be used again, and the attempt is in the audit log. If someone else scanned your
          code, that's where you'll see it.
        </p>
        <Button variant="secondary" icon={<ArrowClockwise size={16} aria-hidden="true" />} onPress={restart}>
          Start again
        </Button>
      </div>
    );
  }

  if (state === 'awaiting-confirm' && device) {
    return (
      <TicketCard
        className={className}
        eyebrow="Safety check"
        tag={<StatusDot state="needs-you" label="answered" />}
        decision={
          <div className="flex flex-col gap-2 medium:flex-row-reverse">
            <Button
              variant="allow"
              size="lg"
              fullWidth
              icon={<Check size={18} weight="bold" aria-hidden="true" />}
              isPending={confirm.isPending && confirm.variables?.accept === true}
              onPress={() => void decide(true)}
            >
              Yes, pair {device.name}
            </Button>
            <Button
              variant="deny"
              size="lg"
              fullWidth
              icon={<X size={18} weight="bold" aria-hidden="true" />}
              isPending={confirm.isPending && confirm.variables?.accept === false}
              onPress={() => void decide(false)}
            >
              No, cancel
            </Button>
          </div>
        }
      >
        <div data-pairing="awaiting-confirm" className="flex flex-col gap-3">
          <p className="type-title-3 text-ink">Does {device.name} show these words?</p>
          <SafetyPhrase words={words} size="lg" />
          <p className="type-body-sm text-ink-2">
            Only confirm if every word matches, in order. If they differ, someone else's code may have been
            swapped in.
          </p>
          {confirm.isError && <p className="type-body-sm text-stop-text">{confirm.error.message}</p>}
        </div>
      </TicketCard>
    );
  }

  const qrSize = compact ? 208 : 240;
  return (
    <div
      className={cx(
        'flex flex-col gap-5 medium:grid medium:grid-cols-[auto_1fr] medium:items-start medium:gap-8',
        className,
      )}
      data-pairing={expired ? 'expired' : 'waiting'}
    >
      <div className="flex flex-col items-start gap-3">
        <div className="relative">
          {showCode ? (
            <div
              className="grid place-items-center rounded-md border border-line bg-surface p-4"
              style={{ width: qrSize, height: qrSize }}
            >
              <div className="text-center">
                <p className="type-micro text-ink-2">Pairing code</p>
                <p
                  className="mt-2 font-mono text-[26px] leading-9 font-semibold tracking-[0.08em] text-ink select-all"
                  aria-label={`Pairing code ${start.data.code.split('').join(' ')}`}
                >
                  {start.data.code}
                </p>
                <p className="mt-1 type-meta text-ink-2">On the phone: beamhop → Enter code</p>
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
                className="relative"
                icon={<ArrowClockwise size={16} weight="bold" aria-hidden="true" />}
                onPress={restart}
              >
                Get a new code
              </Button>
            </div>
          )}
        </div>
        <div className="flex items-baseline gap-3">
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
        <ol className="flex flex-col gap-3">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-start gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full border border-line-strong font-mono text-[11px] text-ink-2">
                {i + 1}
              </span>
              <span className="pt-0.5 type-body-sm text-ink">{s}</span>
            </li>
          ))}
        </ol>
        <section aria-labelledby="pair-phrase" className="flex flex-col gap-2.5">
          <h3 id="pair-phrase" className="type-micro text-ink-2">
            Safety phrase
          </h3>
          <SafetyPhrase />
          <p className="type-body-sm text-ink-2">
            The 4 words appear here once your phone answers. You'll compare them with the phone's.
          </p>
        </section>
        <div className="flex items-center gap-2" role="status">
          <StatusDot state={expired ? 'stopped' : 'needs-you'} label={expired ? 'expired' : 'waiting'} />
          <span className="type-body-sm text-ink-2">
            {expired ? 'This code expired. Get a new one.' : 'Waiting for your phone…'}
          </span>
        </div>
      </div>
    </div>
  );
};
