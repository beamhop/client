import { describe, expect, it } from 'vitest';
import { toastLift } from './Toast.tsx';

// The 1280px inbox case from the bug report: toast at x550–970, decision bar under it.
const toast = { left: 550, right: 970 };
const vh = 850;

describe('toastLift', () => {
  it('lifts the toast above a bottom bar it would cover', () => {
    const bar = { top: 757, bottom: 850, left: 600, right: 1280 };
    expect(toastLift([bar], toast, vh, 220)).toBe(850 - 757 + 8);
  });
  it('ignores bars beside the toast column or far above the bottom', () => {
    expect(toastLift([{ top: 757, bottom: 850, left: 0, right: 540 }], toast, vh, 220)).toBe(0);
    expect(toastLift([{ top: 100, bottom: 160, left: 0, right: 1280 }], toast, vh, 220)).toBe(0);
  });
  it('ignores hidden (zero-size) bars and takes the tallest of several', () => {
    const bars = [
      { top: 0, bottom: 0, left: 0, right: 0 },
      { top: 790, bottom: 850, left: 0, right: 1280 },
      { top: 720, bottom: 790, left: 500, right: 900 },
    ];
    expect(toastLift(bars, toast, vh, 220)).toBe(850 - 720 + 8);
  });
});
