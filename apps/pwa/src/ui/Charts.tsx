/**
 * Hand-rolled SVG charts (DESIGN §4.5, JOURNEYS §6): Sparkline and a stacked BarChart.
 * Never colour alone: series are direct-labelled in the legend rows (which double as the data table),
 * stacked segments carry a 1px surface separator, the tooltip pins above the chart (not under the
 * finger), ←/→ move between bars, and `View as table` renders an accessible table.
 */
import { useId, useMemo, useState } from 'react';
import { cx } from '../lib/cx.ts';
import { announce } from '../lib/live.ts';
import { Button } from './Button.tsx';

const SERIES_COLOR = [
  'var(--bh-chart-1)',
  'var(--bh-chart-2)',
  'var(--bh-chart-3)',
  'var(--bh-chart-4)',
  'var(--bh-chart-5)',
];
export const seriesColor = (i: number) => (i < 5 ? SERIES_COLOR[i]! : 'var(--bh-ink-3)');

export interface SparklineProps {
  values: number[];
  /** Spoken summary, e.g. "Blocked hosts, last 24 hours: 14 events, peak 5 at 10:00". */
  label: string;
  /** Values ≥ this are marked caution (spikes). */
  spikeAt?: number;
  width?: number;
  height?: number;
  className?: string;
  /** Column labels for the hidden table fallback (e.g. hours). */
  labels?: string[];
}

export const Sparkline = ({
  values,
  label,
  spikeAt,
  width = 96,
  height = 20,
  className,
  labels,
}: SparklineProps) => {
  const max = Math.max(1, ...values);
  const bw = width / values.length;
  return (
    <span className={cx('inline-block', className)}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--bh-line)" strokeWidth={1} />
        {values.map((v, i) => {
          const h = v === 0 ? 0 : Math.max(2, (v / max) * (height - 2));
          return (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: positional series
              key={i}
              x={i * bw + 0.5}
              y={height - h - 1}
              width={Math.max(1, bw - 1.5)}
              height={h}
              rx={0.5}
              fill={spikeAt !== undefined && v >= spikeAt ? 'var(--bh-caution-text)' : 'var(--bh-ink-2)'}
            />
          );
        })}
      </svg>
      {labels && (
        <table className="sr-only">
          <caption>{label}</caption>
          <tbody>
            {values.map((v, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional series
              <tr key={i}>
                <th scope="row">{labels[i] ?? i}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </span>
  );
};

export interface BarDatum {
  /** x label, e.g. `12 Nov`. */
  label: string;
  values: Record<string, number>;
}
export interface BarSeries {
  id: string;
  label: string;
}

export interface BarChartProps {
  data: BarDatum[];
  series: BarSeries[];
  /** Accessible chart name, e.g. "Spend per day, last 14 days, by agent". */
  label: string;
  format?: (n: number) => string;
  height?: number;
  className?: string;
  /** Show legend/data rows below the chart (default true). */
  legend?: boolean;
  /** Extra legend columns per series, e.g. tokens. */
  legendExtra?: (seriesId: string) => string;
}

export const BarChart = ({
  data,
  series,
  label,
  format = (n) => String(n),
  height = 160,
  className,
  legend = true,
  legendExtra,
}: BarChartProps) => {
  const [sel, setSel] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [isolated, setIsolated] = useState<string | null>(null);
  const id = useId();
  const shown = isolated ? series.filter((s) => s.id === isolated) : series;
  const totals = data.map((d) => shown.reduce((a, s) => a + (d.values[s.id] ?? 0), 0));
  const max = Math.max(1e-9, ...totals);
  const W = data.length * 11;
  const seriesTotal = useMemo(
    () => Object.fromEntries(series.map((s) => [s.id, data.reduce((a, d) => a + (d.values[s.id] ?? 0), 0)])),
    [data, series],
  );
  const grand = Object.values(seriesTotal).reduce((a, b) => a + b, 0);

  const choose = (i: number) => {
    setSel(i);
    const d = data[i]!;
    announce(
      `${d.label}: ${format(totals[i]!)}. ${shown.map((s) => `${s.label} ${format(d.values[s.id] ?? 0)}`).join(', ')}`,
    );
  };

  return (
    <div className={cx('flex flex-col gap-3', className)}>
      {!asTable ? (
        <>
          <div className="relative">
            <div
              className={cx(
                'mb-2 min-h-12 rounded-md border border-line bg-surface px-3 py-2 type-meta',
                sel === null && 'invisible',
              )}
              aria-hidden="true"
            >
              {sel !== null && (
                <>
                  <span className="text-ink">
                    {data[sel]!.label} · {format(totals[sel]!)}
                  </span>
                  <span className="mt-0.5 flex flex-wrap gap-x-3 text-ink-2">
                    {shown.map((s) => (
                      <span key={s.id} className="inline-flex items-center gap-1">
                        <span
                          className="size-2 rounded-[1px]"
                          style={{ background: seriesColor(series.indexOf(s)) }}
                        />
                        {s.label} {format(data[sel]!.values[s.id] ?? 0)}
                      </span>
                    ))}
                  </span>
                </>
              )}
            </div>
            <div
              role="group"
              tabIndex={0}
              aria-label={`${label}. Use left and right arrow keys to read each bar.`}
              aria-describedby={`${id}-sel`}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  choose(Math.min(data.length - 1, (sel ?? -1) + 1));
                } else if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  choose(Math.max(0, (sel ?? data.length) - 1));
                } else if (e.key === 'Escape') setSel(null);
              }}
              onBlur={() => setSel(null)}
              className="rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-4"
            >
              <svg
                width="100%"
                height={height}
                viewBox={`0 0 ${W} ${height}`}
                preserveAspectRatio="none"
                aria-hidden="true"
                className="block"
              >
                {[0.25, 0.5, 0.75].map((f) => (
                  <line
                    key={f}
                    x1={0}
                    x2={W}
                    y1={height * f}
                    y2={height * f}
                    stroke="var(--bh-line)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray="2 3"
                  />
                ))}
                <line
                  x1={0}
                  x2={W}
                  y1={height - 0.5}
                  y2={height - 0.5}
                  stroke="var(--bh-line-strong)"
                  vectorEffect="non-scaling-stroke"
                />
                {data.map((d, i) => {
                  let y = height;
                  return (
                    <g
                      key={d.label}
                      onPointerEnter={() => setSel(i)}
                      onClick={() => choose(i)}
                      opacity={sel !== null && sel !== i ? 0.45 : 1}
                    >
                      <rect x={i * 11} y={0} width={11} height={height} fill="transparent" />
                      {shown.map((s) => {
                        const v = d.values[s.id] ?? 0;
                        const h = (v / max) * (height - 4);
                        y -= h;
                        return h > 0 ? (
                          <rect
                            key={s.id}
                            x={i * 11 + 2}
                            y={y}
                            width={7}
                            height={h}
                            fill={seriesColor(series.indexOf(s))}
                            stroke="var(--bh-surface)"
                            strokeWidth={1}
                            vectorEffect="non-scaling-stroke"
                          />
                        ) : null;
                      })}
                    </g>
                  );
                })}
              </svg>
              <div className="mt-1 flex justify-between type-meta text-ink-3" aria-hidden="true">
                <span>{data[0]?.label}</span>
                <span>{data.at(-1)?.label}</span>
              </div>
            </div>
            <span id={`${id}-sel`} className="sr-only">
              {sel !== null ? `${data[sel]!.label}: ${format(totals[sel]!)}` : ''}
            </span>
          </div>
          {legend && (
            <ul className="flex flex-col divide-y divide-line border-y border-line" aria-label="Series">
              {series.map((s, i) => (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-pressed={isolated === s.id}
                    onClick={() => setIsolated((x) => (x === s.id ? null : s.id))}
                    className="flex min-h-11 w-full items-center gap-3 px-1 text-left type-meta hover:bg-sunken"
                  >
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-[2px]"
                      style={{ background: seriesColor(i) }}
                    />
                    <span className="min-w-0 flex-1 truncate text-ink">{s.label}</span>
                    <span className="w-16 text-right text-ink tabular-nums">
                      {format(seriesTotal[s.id] ?? 0)}
                    </span>
                    {legendExtra && (
                      <span className="w-20 text-right text-ink-2 tabular-nums">{legendExtra(s.id)}</span>
                    )}
                    <span className="w-10 text-right text-ink-2 tabular-nums">
                      {grand ? Math.round(((seriesTotal[s.id] ?? 0) / grand) * 100) : 0}%
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full border-collapse type-meta">
            <caption className="sr-only">{label}</caption>
            <thead>
              <tr className="border-b border-line bg-sunken text-ink-2">
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Day
                </th>
                {series.map((s) => (
                  <th key={s.id} scope="col" className="px-3 py-2 text-right font-normal">
                    {s.label}
                  </th>
                ))}
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label} className="border-b border-line last:border-b-0">
                  <th scope="row" className="px-3 py-2 text-left font-normal text-ink">
                    {d.label}
                  </th>
                  {series.map((s) => (
                    <td key={s.id} className="px-3 py-2 text-right text-ink-2 tabular-nums">
                      {format(d.values[s.id] ?? 0)}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right text-ink tabular-nums">
                    {format(series.reduce((a, s) => a + (d.values[s.id] ?? 0), 0))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Button variant="quiet" size="sm" className="self-start" onPress={() => setAsTable((t) => !t)}>
        {asTable ? 'View as chart' : 'View as table'}
      </Button>
    </div>
  );
};
