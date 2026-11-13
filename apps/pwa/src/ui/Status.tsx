/**
 * Status vocabulary: StatusDot (lamp + word), SignalBars (hop meter + number), SegmentedMeter (budget),
 * RouteLine (beam line with in-flight pulse). DESIGN §3.
 */
import { AnimatePresence, motion } from 'motion/react';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import type { LampState } from '../api/derive.ts';
import { t as tr } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';
import { HopMeter, Lamp } from './glyphs/index.tsx';
import { useReduced } from './motion.ts';

export const LAMP_WORD: Record<LampState, string> = {
  live: 'live',
  ready: 'ready',
  'needs-you': 'needs you',
  paused: 'paused',
  stopped: 'stopped',
  error: 'error',
  offline: 'offline',
  panic: 'stopped by panic',
};

const WORD_COLOR: Record<LampState, string> = {
  live: 'text-flare-text',
  ready: 'text-go-text',
  'needs-you': 'text-caution-text',
  paused: 'text-ink-2',
  stopped: 'text-ink-2',
  error: 'text-stop-text',
  offline: 'text-stop-text',
  panic: 'text-stop-text',
};

export interface StatusDotProps {
  state: LampState;
  /** Override the word (e.g. `learning`, `login`, `12 s ago`). */
  label?: string;
  /** Visually hide the word (it stays in the accessibility tree). */
  hideLabel?: boolean;
  className?: string;
}

/** Shape + colour + word, always (WCAG 1.4.1). */
export const StatusDot = ({ state, label, hideLabel, className }: StatusDotProps) => {
  const word = label ?? LAMP_WORD[state];
  return (
    <span
      className={cx('inline-flex items-center gap-1.5 type-meta whitespace-nowrap', className)}
      data-state={state}
    >
      <Lamp state={state} />
      <span className={cx(hideLabel ? 'sr-only' : WORD_COLOR[state])}>{word}</span>
    </span>
  );
};

export interface SignalBarsProps {
  up: number;
  total: number;
  /** Unit after the number: `relays`, `hops`. */
  unit?: string;
  /** Turns caution at the limit (hop counts). */
  limit?: boolean;
  /** Animate bars (connecting). */
  busy?: boolean;
  hideNumber?: boolean;
  className?: string;
}

/** Hop meter + mono number: `▂▄▆█ 3/4 relays`. A number beside every meter (DESIGN §2). */
export const SignalBars = ({ up, total, unit, limit, busy, hideNumber, className }: SignalBarsProps) => (
  <span
    className={cx(
      'inline-flex items-center gap-2 type-meta tabular-nums',
      limit ? 'text-caution-text' : 'text-ink-2',
      className,
    )}
  >
    <HopMeter up={up} total={total} tone={limit ? 'caution' : 'ink'} busy={busy} />
    <span className={hideNumber ? 'sr-only' : undefined}>
      {up}/{total}
      {unit ? ` ${unit}` : ''}
    </span>
  </span>
);

export interface SegmentedMeterProps {
  value: number;
  max: number;
  /** Readout text, e.g. `$3.20 / $5.00 today`. */
  label: ReactNode;
  /** Spoken value, e.g. `$3.20 of $5.00 used today`. */
  valueText: string;
  /** Accessible name, e.g. `reviewer budget`. */
  name: string;
  segments?: number;
  className?: string;
  compact?: boolean;
}

/** 10-segment VU-style meter for budgets (DESIGN §3.5). */
export const SegmentedMeter = ({
  value,
  max,
  label,
  valueText,
  name,
  segments = 10,
  className,
  compact,
}: SegmentedMeterProps) => {
  const pct = max > 0 ? value / max : 0;
  const filled = Math.min(segments, Math.round(pct * segments));
  const fill = pct >= 1 ? 'bg-stop' : pct >= 0.8 ? 'bg-caution-text' : 'bg-ink';
  return (
    <div className={cx('flex items-center gap-3', className)}>
      <div
        role="meter"
        aria-label={name}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuetext={valueText}
        className={cx('flex gap-[2px]', compact ? 'w-20' : 'w-28 min-w-0 flex-1 max-w-40')}
      >
        {Array.from({ length: segments }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed segments
          <span key={i} className={cx('h-1.5 flex-1 rounded-[1px]', i < filled ? fill : 'bg-line')} />
        ))}
      </div>
      <span
        className={cx(
          'type-meta whitespace-nowrap tabular-nums',
          pct >= 1 ? 'text-stop-text' : pct >= 0.8 ? 'text-caution-text' : 'text-ink-2',
        )}
      >
        {label}
      </span>
    </div>
  );
};

export interface RouteNode {
  label: string;
  kind: 'channel' | 'agent' | 'relay' | 'device';
}

export interface RouteLineProps {
  nodes: RouteNode[];
  /** Increment to send one pulse along the line (max 2 concurrent). */
  pulse?: number;
  /** Pulse travels from the last node back to the first. */
  reverse?: boolean;
  /** Keep sending pulses while true (agent streaming). */
  live?: boolean;
  state?: 'ok' | 'broken' | 'blocked';
  /** Reason shown under a broken/blocked line. */
  reason?: string;
  className?: string;
  'aria-label'?: string;
}

const NodeMark = ({ kind, filled }: { kind: RouteNode['kind']; filled?: boolean }) =>
  kind === 'channel' || kind === 'device' ? (
    <span className={cx('size-2 shrink-0 border border-ink', filled ? 'bg-flare' : 'bg-ink')} />
  ) : kind === 'agent' ? (
    <span
      className={cx(
        'size-2.5 shrink-0 rounded-full border-[1.5px] border-ink',
        filled ? 'bg-flare' : 'bg-surface',
      )}
    />
  ) : (
    <span className="size-1.5 shrink-0 rounded-full bg-ink-2" />
  );

/**
 * Beam line between named nodes. `nostr:dm ──●── reviewer`. The pulse is a 16px flare segment;
 * with reduced motion the destination node fills for 400 ms instead (DESIGN §3.1).
 */
export const RouteLine = ({
  nodes,
  pulse = 0,
  reverse,
  live,
  state = 'ok',
  reason,
  className,
  ...aria
}: RouteLineProps) => {
  const reduce = useReduced();
  const [pulses, setPulses] = useState<number[]>([]);
  const [flash, setFlash] = useState(false);
  const counter = useRef(0);

  const fire = () => {
    if (reduce) {
      setFlash(true);
      window.setTimeout(() => setFlash(false), 400);
      return;
    }
    const id = ++counter.current;
    setPulses((p) => [...p.slice(-1), id]);
    window.setTimeout(() => setPulses((p) => p.filter((x) => x !== id)), 700);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: fire on pulse changes only
  useEffect(() => {
    if (pulse > 0) fire();
  }, [pulse]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: interval tied to live flag
  useEffect(() => {
    if (!live || state !== 'ok') return;
    fire();
    const t = window.setInterval(fire, 1800);
    return () => window.clearInterval(t);
  }, [live, state, reduce]);

  const label = aria['aria-label'] ?? nodes.map((n) => n.label).join(' to ');
  const dest = reverse ? 0 : nodes.length - 1;
  return (
    <div className={cx('min-w-0', className)}>
      <div
        role="img"
        aria-label={`Route: ${label}${state === 'broken' ? tr('ui.status.broken') : state === 'blocked' ? tr('ui.status.blockedByPolicy') : ''}`}
        className="flex min-w-0 items-center gap-2 type-meta text-ink-2"
      >
        {nodes.map((n, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat; position is identity
          <Fragment key={`${n.label}-${i}`}>
            {i > 0 && (
              <span
                className="relative flex h-3 min-w-6 flex-1 items-center overflow-hidden"
                aria-hidden="true"
              >
                <span
                  className={cx(
                    'h-px w-full',
                    state === 'broken'
                      ? 'border-t border-dashed border-stop-text bg-transparent'
                      : 'bg-line-strong',
                  )}
                  style={state === 'broken' ? { borderTopStyle: 'dashed' } : undefined}
                />
                {nodes.length === 2 && state === 'ok' && (
                  <span className="absolute left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-ink-2" />
                )}
                {state === 'blocked' && i === nodes.length - 1 && (
                  <span className="absolute right-0 h-3 w-[2px] bg-caution-text" />
                )}
                {state === 'broken' && i === nodes.length - 1 && (
                  <span className="absolute left-1/2 -translate-x-1/2 bg-bg px-0.5 font-mono text-[10px] leading-none text-stop-text">
                    ✕
                  </span>
                )}
                <AnimatePresence>
                  {pulses.map((id) => (
                    <motion.span
                      key={id}
                      className="absolute top-1/2 h-[2px] w-4 -translate-y-1/2 bg-flare"
                      initial={{ left: reverse ? '100%' : '-16px', opacity: 1 }}
                      animate={{ left: reverse ? '-16px' : '100%' }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.6, ease: 'linear' }}
                    />
                  ))}
                </AnimatePresence>
              </span>
            )}
            <span className="flex min-w-0 shrink items-center gap-1.5">
              {n.kind !== 'relay' && <NodeMark kind={n.kind} filled={flash && i === dest} />}
              <span className={cx('min-w-0 truncate', n.kind === 'agent' && 'text-ink')} title={n.label}>
                {n.label}
              </span>
            </span>
          </Fragment>
        ))}
      </div>
      {reason && state !== 'ok' && (
        <p className={cx('mt-1 type-meta', state === 'broken' ? 'text-stop-text' : 'text-caution-text')}>
          {reason}
        </p>
      )}
    </div>
  );
};
