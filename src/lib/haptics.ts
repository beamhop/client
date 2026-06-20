// Dependency-free haptics with a swappable driver seam.
//
// WHY a seam: iOS Safari ships NO Web Vibration API — `navigator.vibrate` is
// `undefined` there — so the built-in web driver is a graceful no-op on iOS. The
// real value of this module is that a native driver (e.g. @capacitor/haptics)
// can be slotted in at boot via `setHapticDriver` without touching any call
// sites. Everything else (enabled flag, throttle) lives above the driver so it
// applies uniformly regardless of which driver is active.

export type HapticIntent = "light" | "medium" | "heavy" | "success" | "warning" | "selection";

export interface HapticDriver {
  impact: (intent: HapticIntent) => void;
}

// Vibration patterns per intent. A single number is a one-shot buzz; an array is
// an on/off millisecond sequence (used to give success/warning a distinct
// "texture"). Kept `readonly` so they can't be mutated in place — we hand a
// fresh mutable copy to `navigator.vibrate` (which wants `number | number[]`)
// via spread.
const PATTERNS: Readonly<Record<HapticIntent, readonly number[] | number>> = {
  light: 10,
  medium: 20,
  heavy: 30,
  selection: 8,
  success: [12, 40, 12],
  warning: [20, 60, 20],
};

// The built-in web driver. Feature-detect once at module load: on iOS Safari
// (and any non-vibrating environment) `navigator.vibrate` is absent, so this
// becomes a hard no-op rather than throwing.
const webVibrateSupported = (): boolean =>
  typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

const webDriver: HapticDriver = {
  impact: (intent) => {
    if (!webVibrateSupported()) return;
    const pattern = PATTERNS[intent];
    // Spread-copy: `navigator.vibrate` wants a mutable `number | number[]`, and
    // we never want it mutating our shared literal.
    navigator.vibrate(typeof pattern === "number" ? pattern : [...pattern]);
  },
};

const STORAGE_KEY = "beamhop.haptics.v1";

// Module-level mutable state. `driver` defaults to the web driver and can be
// swapped at boot. `enabled` is lazily hydrated from localStorage on first read
// (so importing this module has no side effects / no storage access). `lastFire`
// powers the throttle.
let driver: HapticDriver = webDriver;
let enabled: boolean | undefined;
let lastFire = 0;

// Min gap between fires. WHY: a burst of toasts / rapid list selections would
// otherwise machine-gun the motor into an unpleasant continuous buzz.
const THROTTLE_MS = 120;

const loadEnabled = (): boolean => {
  // Tolerate localStorage throwing (private mode, disabled storage). Absence of
  // a stored value means default ON.
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
};

/** Swap in a native driver (e.g. Capacitor) at boot; pass null to revert to the built-in web driver. */
export const setHapticDriver = (next: HapticDriver | null): void => {
  driver = next ?? webDriver;
};

/** Persisted on/off (localStorage "beamhop.haptics.v1", default ON). */
export const setHapticsEnabled = (next: boolean): void => {
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
  } catch {
    // Persistence is best-effort; the in-memory flag still takes effect.
  }
};

export const isHapticsEnabled = (): boolean => {
  if (enabled === undefined) enabled = loadEnabled();
  return enabled;
};

/** Fire a haptic. No-ops when: disabled, unsupported (no driver), or throttled (<120ms since last). Never throws. */
export const haptic = (intent: HapticIntent): void => {
  if (!isHapticsEnabled()) return;
  const now = Date.now();
  if (now - lastFire < THROTTLE_MS) return;
  lastFire = now;
  try {
    driver.impact(intent);
  } catch {
    // A misbehaving driver must never break a call site. Haptics are cosmetic.
  }
};
