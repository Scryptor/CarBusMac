import { test, expect } from "vitest";
import { sampleToTiming, PRESET_BITRATES } from "../src/lib/timing";

test("timing sample point within 50-90 rejects out of range", () => {
  expect(() => sampleToTiming(500_000, 120_000_000, 95)).toThrow();
  expect(() => sampleToTiming(500_000, 120_000_000, 40)).toThrow();
});

test("preset 500k produces integer prescaler and ~target sample point", () => {
  const t = sampleToTiming(500_000, 120_000_000, 80);
  expect(Number.isInteger(t.prescaler)).toBe(true);
  const sp = ((1 + t.seg1) / (1 + t.seg1 + t.seg2)) * 100;
  expect(Math.abs(sp - 80)).toBeLessThanOrEqual(2);
});

test("preset list includes common classic bitrates", () => {
  expect(PRESET_BITRATES).toContain(500_000);
  expect(PRESET_BITRATES).toContain(1_000_000);
});
