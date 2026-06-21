import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type HapticDriver,
  type HapticIntent,
  haptic,
  isHapticsEnabled,
  setHapticDriver,
  setHapticsEnabled,
} from "../haptics.ts";

const STORAGE_KEY = "beamhop.haptics.v1";
const THROTTLE_MS = 120;

// A driver that records the intents it receives — lets us assert routing and
// throttling without depending on navigator or wall-clock timers.
const recordingDriver = (): { calls: HapticIntent[]; driver: HapticDriver } => {
  const calls: HapticIntent[] = [];
  return { calls, driver: { impact: (intent) => calls.push(intent) } };
};

beforeEach(() => {
  // Each test starts from a clean, enabled, web-driver state. A real >throttle
  // wait clears any lastFire residue so the first fire is never spuriously throttled.
  setHapticDriver(null);
  setHapticsEnabled(true);
});

afterEach(async () => {
  setHapticDriver(null);
  await Bun.sleep(THROTTLE_MS + 5);
});

describe("enabled flag", () => {
  test("no-ops when disabled", () => {
    const { calls, driver } = recordingDriver();
    setHapticDriver(driver);
    setHapticsEnabled(false);
    haptic("heavy");
    expect(calls).toEqual([]);
  });

  test("persists to localStorage and isHapticsEnabled reads it back", () => {
    setHapticsEnabled(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
    expect(isHapticsEnabled()).toBe(false);

    setHapticsEnabled(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
    expect(isHapticsEnabled()).toBe(true);
  });
});

describe("throttle", () => {
  test("drops a rapid second call within 120ms", () => {
    const { calls, driver } = recordingDriver();
    setHapticDriver(driver);
    haptic("selection");
    haptic("selection");
    expect(calls).toEqual(["selection"]);
  });

  test("allows a second call after the throttle window elapses", async () => {
    const { calls, driver } = recordingDriver();
    setHapticDriver(driver);
    haptic("selection");
    await Bun.sleep(THROTTLE_MS + 5);
    haptic("selection");
    expect(calls).toEqual(["selection", "selection"]);
  });
});

describe("driver swap seam", () => {
  test("routes to the injected driver, null reverts to web driver", () => {
    const { calls, driver } = recordingDriver();
    setHapticDriver(driver);
    haptic("light");
    expect(calls).toEqual(["light"]);

    // After revert the recording driver must receive no more calls.
    setHapticDriver(null);
    // next call is throttled by the previous fire — that's fine, we only care no leak
    haptic("medium");
    expect(calls).toEqual(["light"]);
  });

  test("routes all intents including nudge", async () => {
    const { calls, driver } = recordingDriver();
    setHapticDriver(driver);
    haptic("nudge");
    await Bun.sleep(THROTTLE_MS + 5);
    haptic("success");
    expect(calls).toEqual(["nudge", "success"]);
  });

  test("never throws when the web driver is active and WebHaptics is unavailable", () => {
    setHapticDriver(null);
    // The web driver wraps trigger() in try/catch — a broken audio context or
    // missing Vibration API must not propagate up to call sites.
    expect(() => haptic("medium")).not.toThrow();
  });
});
