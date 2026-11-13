import { cx } from '../lib/cx.ts';

/** `beamhop■` — Instrument Sans 600 wdth 75, lowercase, flare square on the baseline (DESIGN §3.10). */
export const Wordmark = ({ className, size = 22 }: { className?: string; size?: number }) => (
  <span
    className={cx('inline-flex items-baseline wordmark text-ink', className)}
    style={{ fontSize: size, lineHeight: 1 }}
  >
    beamhop
    <span aria-hidden="true" className="ml-[0.06em] inline-block size-[0.25em] bg-flare-text dark:bg-flare" />
  </span>
);
