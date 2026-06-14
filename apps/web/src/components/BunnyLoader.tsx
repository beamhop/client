import type { ReactNode } from 'react';
import { BeamhopBunny } from './BeamhopBunny.js';

export interface BunnyLoaderProps {
  /** Caption shown under the hopping bunny. */
  label?: string;
  /** Bunny size in px. */
  size?: number;
  /** Forwarded to the wrapper so existing loading test ids are preserved. */
  testId?: string;
}

/** A centered hopping bunny + optional caption — the app's loading indicator. */
export function BunnyLoader({ label, size = 76, testId }: BunnyLoaderProps): ReactNode {
  return (
    <div
      data-testid={testId}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: 'var(--text-3)', fontSize: 14 }}
    >
      <BeamhopBunny state="spinner" size={size} label={label ?? 'Loading'} />
      {label ? <span>{label}</span> : null}
    </div>
  );
}
