// Haptics via web-haptics (https://github.com/lochie/web-haptics), with a
// swappable driver seam for testability and future native overrides.
//
// WHY web-haptics over raw navigator.vibrate: the library drives both the
// Vibration API and a silent AudioContext click, which means it reaches iOS
// Safari (where navigator.vibrate is undefined) via the audio path. It also
// ships richer intensity-aware patterns (nudge, soft, rigid) that we map to
// new semantic intents below.

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

// Lazily created so importing this module has no side effects.
let _haptics: WebHaptics | undefined;
const getHaptics = (): WebHaptics => {
  if (!_haptics) _haptics = new WebHaptics({ showSwitch: false });
  return _haptics;
};

// The default driver delegates to web-haptics, which handles feature detection
// and iOS fallback internally.
const webDriver: HapticDriver = {
  impact: (intent) => {
    void getHaptics().trigger(intent);
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
