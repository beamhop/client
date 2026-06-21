import { describe, expect, test } from "bun:test";
import { classifyAxis, pullResistance } from "../gestures.ts";

describe("classifyAxis", () => {
  test("returns 'none' inside the deadzone (boundary is inclusive)", () => {
    expect(classifyAxis(0, 0)).toBe("none");
    expect(classifyAxis(8, 0)).toBe("none"); // exactly deadzone → still none
    expect(classifyAxis(0, 8)).toBe("none");
    expect(classifyAxis(8, 8)).toBe("none");
    expect(classifyAxis(5, -5)).toBe("none");
  });

  test("escapes the deadzone one pixel past the boundary", () => {
    expect(classifyAxis(9, 0)).toBe("horizontal");
    expect(classifyAxis(0, 9)).toBe("vertical");
  });

  test("locks horizontal when |dx| dominates |dy| by the ratio", () => {
    // ax=20, ay=10 → 20 >= 10*1.2 (12) → horizontal
    expect(classifyAxis(20, 10)).toBe("horizontal");
    expect(classifyAxis(100, 0)).toBe("horizontal");
  });

  test("locks vertical when |dy| dominates", () => {
    // ax=10, ay=20 → 10 >= 20*1.2? no → vertical
    expect(classifyAxis(10, 20)).toBe("vertical");
    expect(classifyAxis(0, 100)).toBe("vertical");
  });

  test("ratio tie-break: equal magnitudes lock vertical (ratio > 1)", () => {
    // ax=ay=20 → 20 >= 20*1.2 (24)? no → vertical
    expect(classifyAxis(20, 20)).toBe("vertical");
    expect(classifyAxis(-30, 30)).toBe("vertical");
  });

  test("ratio boundary: exactly ay*ratio counts as horizontal", () => {
    // ax=24, ay=20 → 24 >= 24 → horizontal (>=, not >)
    expect(classifyAxis(24, 20)).toBe("horizontal");
    // ax=23.9 just under → vertical
    expect(classifyAxis(23.9, 20)).toBe("vertical");
  });

  test("uses magnitudes — sign of dx/dy is irrelevant to the axis", () => {
    expect(classifyAxis(-100, 5)).toBe("horizontal");
    expect(classifyAxis(5, -100)).toBe("vertical");
    expect(classifyAxis(-50, -10)).toBe("horizontal");
    expect(classifyAxis(-10, -50)).toBe("vertical");
  });

  test("honours a custom deadzone", () => {
    expect(classifyAxis(15, 0, 20)).toBe("none"); // 15 <= 20
    expect(classifyAxis(21, 0, 20)).toBe("horizontal");
  });

  test("honours a custom ratio", () => {
    // ratio 1.0: equal magnitudes now tie to horizontal (ax >= ay*1)
    expect(classifyAxis(20, 20, 8, 1)).toBe("horizontal");
    // ratio 3: needs ax >= ay*3 for horizontal
    expect(classifyAxis(50, 20, 8, 3)).toBe("vertical"); // 50 < 60
    expect(classifyAxis(60, 20, 8, 3)).toBe("horizontal"); // 60 >= 60
  });

  test("a large deadzone can suppress otherwise-decisive deltas", () => {
    expect(classifyAxis(40, 40, 50)).toBe("none");
  });
});

describe("pullResistance", () => {
  test("zero and negative raw pulls clamp to 0", () => {
    expect(pullResistance(0, 96)).toBe(0);
    expect(pullResistance(-20, 96)).toBe(0);
  });

  test("tracks 1:1 up to and including max", () => {
    expect(pullResistance(10, 96)).toBe(10);
    expect(pullResistance(50, 96)).toBe(50);
    expect(pullResistance(96, 96)).toBe(96);
  });

  test("dampens overshoot past max (rubber-band)", () => {
    const over = pullResistance(200, 96);
    // Strictly greater than max but far less than the raw 200.
    expect(over).toBeGreaterThan(96);
    expect(over).toBeLessThan(200);
  });

  test("is monotonic non-decreasing across the cap boundary", () => {
    const just = pullResistance(96, 96);
    const past = pullResistance(120, 96);
    const further = pullResistance(400, 96);
    expect(past).toBeGreaterThanOrEqual(just);
    expect(further).toBeGreaterThan(past);
  });

  test("overshoot dampening uses log10 with the documented coefficient", () => {
    // raw = max + 9 → overshoot 9 → log10(10)=1 → max + 1*(max/8)
    const max = 80;
    expect(pullResistance(max + 9, max)).toBeCloseTo(max + max / 8, 10);
  });
});
