import type { CSSProperties, ReactNode } from 'react';

/** Brand beam (teal) — fixed across themes, matches the brand palette. */
const BEAM = '#5EEAD4';

export interface BeamhopLogoProps {
  /** Wordmark font size in px. */
  size?: number;
  style?: CSSProperties;
}

/**
 * The beamhop wordmark: "beam" in brand teal + "hop" in theme ink. Static brand
 * mark used wherever the app needs its logo (sidebar, login, splash, header).
 */
export function BeamhopLogo({ size = 20, style }: BeamhopLogoProps): ReactNode {
  return (
    <span
      aria-label="beamhop"
      data-testid="beamhop-logo"
      style={{
        fontFamily: "'Space Grotesk', system-ui, sans-serif",
        fontWeight: 700,
        fontSize: size,
        letterSpacing: '-0.03em',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        userSelect: 'none',
        ...style,
      }}
    >
      <span style={{ color: BEAM }}>beam</span>
      <span style={{ color: 'var(--text)' }}>hop</span>
    </span>
  );
}
