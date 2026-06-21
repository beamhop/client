// Haptics with a swappable driver seam.
//
// Android: delegates to web-haptics (WebHaptics class) which uses
// navigator.vibrate with richer intensity-aware patterns.
//
// iOS: web-haptics's own iOS path is broken — it creates a
// `<input type="checkbox" switch="">` but sets display:none on it, which
// silences the system haptic. We bypass it and implement the checkbox trick
// directly with the element positioned off-screen (rendered but not visible).
// iOS Safari fires a system haptic on every toggle of an <input switch>.

import { WebHaptics } from "web-haptics";

export type HapticIntent =
  | "light"
  | "medium"
  | "heavy"
  | "success"
  | "warning"
  | "selection"
  | "nudge";

export interface HapticDriver {
  impact: (intent: HapticIntent) => void;
}

// --- Android / Vibration API path ---

let _haptics: WebHaptics | undefined;
const getHaptics = (): WebHaptics => {
  if (!_haptics) _haptics = new WebHaptics({ showSwitch: false });
  return _haptics;
};

// --- iOS <input switch> path ---

let _iosSwitch: HTMLInputElement | undefined;

const getIOSSwitch = (): HTMLInputElement | undefined => {
  if (_iosSwitch) return _iosSwitch;
  if (typeof document === "undefined" || !document.body) return undefined;
  const el = document.createElement("input");
  el.type = "checkbox";
  el.setAttribute("switch", "");
  // Must stay in the layout tree — display:none silences the system haptic.
  Object.assign(el.style, {
    position: "fixed",
    top: "-9999px",
    left: "-9999px",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.appendChild(el);
  _iosSwitch = el;
  return el;
};

const iosClick = (): void => {
  getIOSSwitch()?.click();
};

// Each toggle of the switch fires one system haptic pulse. Multi-pulse intents
// schedule additional clicks. These bypass the module throttle intentionally —
// they're part of a single haptic() call's pattern, not a new user action.
const IOS_PULSES: Record<HapticIntent, [count: number, gapMs: number]> = {
  selection: [1, 0],
  light:     [1, 0],
  medium:    [1, 0],
  heavy:     [1, 0],
  success:   [2, 80],
  warning:   [2, 60],
  nudge:     [2, 100],
};

const iosHaptic = (intent: HapticIntent): void => {
  const [count, gap] = IOS_PULSES[intent];
  iosClick();
  if (count > 1) setTimeout(iosClick, gap);
};

// --- Unified web driver ---

const webDriver: HapticDriver = {
  impact: (intent) => {
    if (WebHaptics.isSupported) {
      void getHaptics().trigger(intent);
    } else {
      iosHaptic(intent);
    }
  },
};

const STORAGE_KEY = "beamhop.haptics.v1";

let driver: HapticDriver = webDriver;
let enabled: boolean | undefined;
let lastFire = 0;

// Min gap between fires — prevents toast/selection bursts from machine-gunning
// the motor into an unpleasant continuous buzz.
const THROTTLE_MS = 120;

const loadEnabled = (): boolean => {
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
    // Persistence is best-effort; in-memory flag still takes effect.
  }
};

export const isHapticsEnabled = (): boolean => {
  if (enabled === undefined) enabled = loadEnabled();
  return enabled;
};

/** Fire a haptic. No-ops when disabled or throttled (<120ms since last). Never throws. */
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
