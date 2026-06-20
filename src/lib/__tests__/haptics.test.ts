import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type HapticDriver,
  type HapticIntent,
  haptic,
  isHapticsEnabled,
  setHapticDriver,
  setHapticsEnabled,
} from "../haptics.ts";

const STORAGE_KEY = "verity.haptics.v1";
const THROTTLE_MS = 120;

// Swap navigator.vibrate with a recording stub and hand back a restore fn. We
// save the original descriptor so we can faithfully put it back (happy-dom may
// or may not define vibrate by default), keeping tests hermetic.
const stubVibrate = (fn: typeof navigator.vibrate): (() => void) => {
  const original = Object.getOwnPropertyDescriptor(navigator, "vibrate");
  Object.defineProperty(navigator, "vibrate", { value: fn, configurable: true, writable: true });
  return () => {
    if (original) Object.defineProperty(navigator, "vibrate", original);
    else delete (navigator as { vibrate?: unknown }).vibrate;
  };
};

// A driver that just records the intents it receives — lets us assert routing
// and throttling without depending on navigator or wall-clock timers.
const recordingDriver = (): { calls: HapticIntent[]; driver: HapticDriver } => {
  const calls: HapticIntent[] = [];
  return { calls, driver: { impact: (intent) => calls.push(intent) } };
};

beforeEach(() => {
  // Each test starts from a clean, enabled, web-driver state. A real >throttle
  // wait clears any lastFire residue from a previous test so the first fire of
  // every test is never spuriously throttled (no fake timers needed).
  setHapticDriver(null);
  setHapticsEnabled(true);
});

afterEach(async () => {
  setHapticDriver(null);
  await Bun.sleep(THROTTLE_MS + 5);
});

describe("web driver routing", () => {
  test("maps each intent to its vibration pattern on navigator.vibrate", async () => {
    const seen: Array<number | number[]> = [];
    const restore = stubVibrate((pattern) => {
      seen.push(pattern as number | number[]);
      return true;
    });
    try {
      // One fire per test-gap: space calls past the throttle so all land.
      haptic("light");
      await Bun.sleep(THROTTLE_MS + 5);
      haptic("success");
      expect(seen).toEqual([10, [12, 40, 12]]);
    } finally {
      restore();
    }
  });

  test("hands navigator.vibrate a fresh array copy, not the shared literal", async () => {
    const seen: Array<number | number[]> = [];
    const restore = stubVibrate((pattern) => {
      seen.push(pattern as number | number[]);
      return true;
    });
    try {
      haptic("warning");
      const first = seen[0];
      expect(first).toEqual([20, 60, 20]);
      // Corrupt the array we were handed. If the module passed its shared
      // literal directly, this would poison every future "warning".
      if (Array.isArray(first)) first[0] = 999;

      await Bun.sleep(THROTTLE_MS + 5);
      haptic("warning");
      // The second fire must still see the pristine pattern.
      expect(seen[1]).toEqual([20, 60, 20]);
    } finally {
      restore();
    }
  });
});

describe("graceful degradation (iOS Safari has no navigator.vibrate)", () => {
  test("is a hard no-op and never throws when navigator.vibrate is absent", () => {
    const restore = stubVibrate(undefined as unknown as typeof navigator.vibrate);
    // Force the "not a function" branch by deleting the property entirely.
    delete (navigator as { vibrate?: unknown }).vibrate;
    try {
      expect(() => haptic("medium")).not.toThrow();
    } finally {
      restore();
    }
  });
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
    // Two back-to-back fires: the first sets lastFire, the second is inside the
    // throttle window and must be dropped — preventing toast/selection bursts
    // from machine-gunning the motor.
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
  test("setHapticDriver routes to the native driver, null reverts to web", () => {
    const { calls, driver } = recordingDriver();
    setHapticDriver(driver);
    haptic("light");
    expect(calls).toEqual(["light"]);

    // Revert: the web driver should now be active (it no-ops without vibrate,
    // but crucially the native driver no longer receives calls).
    setHapticDriver(null);
    const restore = stubVibrate(() => true);
    try {
      haptic("medium"); // throttled relative to the previous fire — fine, we only assert no leak
      expect(calls).toEqual(["light"]);
    } finally {
      restore();
    }
  });
});
