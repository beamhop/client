/**
 * QR display (JOURNEYS §1.04, §9): ink modules on surface, 4-module quiet zone, min 240px.
 * Rendered as our own SVG path from the `qrcode` module matrix (no innerHTML, follows theme).
 * Modules are `ink-2` (≥7.9:1 on surface in both themes, plenty for a camera) so a 240px code doesn't
 * outweigh the rest of the screen; high contrast switches them to pure `ink`. No frame on compact
 * screens — the 4-module quiet zone is the frame.
 */
import QRCode from 'qrcode';
import { useMemo } from 'react';
import { cx } from '../lib/cx.ts';

export interface QrCodeProps {
  value: string;
  /** Accessible description, e.g. "QR code to pair your phone". */
  label: string;
  size?: number;
  className?: string;
}

export const QrCode = ({ value, label, size = 240, className }: QrCodeProps) => {
  const { path, n } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const count = qr.modules.size;
    const data = qr.modules.data;
    let d = '';
    for (let y = 0; y < count; y++) {
      for (let x = 0; x < count; x++) {
        if (data[y * count + x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
      }
    }
    return { path: d, n: count + 8 };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${n} ${n}`}
      shapeRendering="crispEdges"
      className={cx(
        'rounded-md bg-surface medium:border medium:border-line hc:border hc:border-line',
        className,
      )}
    >
      <rect width={n} height={n} fill="var(--bh-surface)" />
      <path d={path} className="fill-ink-2 hc:fill-ink" />
    </svg>
  );
};
