import { expect, test } from "vitest";
import { bestTiming, PRESET_BITRATES, timingError, timingInfo } from "../src/lib/timing";

const CLOCK = 120_000_000;

test("bestTiming 500k@120MHz,75% gives exact rate and sample point", () => {
  const t = bestTiming(500_000, CLOCK, 75)!;
  expect(timingInfo(t, CLOCK, 500_000)).toEqual({ bitrate: 500_000, samplePct: 75, accuracyPct: 0 });
  expect(1 + t.seg1 + t.seg2).toBeLessThanOrEqual(25);
  expect(t.sjw).toBe(Math.min(t.seg2, 4));
});

test("timingInfo reports actual rate, sample point and deviation", () => {
  expect(timingInfo({ prescaler: 15, seg1: 12, seg2: 3, sjw: 1 }, CLOCK, 500_000)).toEqual({
    bitrate: 500_000,
    samplePct: 81.25,
    accuracyPct: 0,
  });
  // 120 МГц / (212 × 17) = 33 296,3 бит/с — на 0,011 % медленнее 33,3k
  const off = timingInfo({ prescaler: 212, seg1: 12, seg2: 4, sjw: 1 }, CLOCK, 33_300);
  expect(off.bitrate).toBeCloseTo(33_296.3, 1);
  expect(off.accuracyPct).toBeCloseTo(-0.011, 3);
  expect(timingInfo({ prescaler: 15, seg1: 12, seg2: 3, sjw: 1 }, CLOCK).accuracyPct).toBe(0);
});

test("bestTiming picks the closest rate for 33.3k", () => {
  const t = bestTiming(33_300, CLOCK, 75)!;
  expect(timingInfo(t, CLOCK, 33_300).accuracyPct).toBeCloseTo(-0.011, 3);
});

test("bestTiming honours limits and rejects impossible input", () => {
  const slow = bestTiming(10_000, CLOCK, 87.5)!;
  expect(slow.prescaler).toBeLessThanOrEqual(512);
  expect(timingInfo(slow, CLOCK, 10_000).accuracyPct).toBe(0);
  expect(bestTiming(500_000, CLOCK, 95)).toBeNull();
  expect(bestTiming(500_000, CLOCK, 40)).toBeNull();
  expect(bestTiming(20_000_000, CLOCK, 75)).toBeNull(); // меньше 8 квантов на бит
  expect(bestTiming(5_000, CLOCK, 75, { presc: [1, 64], seg1: [1, 16], seg2: [1, 8], sjw: [1, 4] })).toBeNull();
});

test("presets match carbus-lib nominal bitrate table", () => {
  expect(PRESET_BITRATES).toEqual([
    10_000, 20_000, 33_300, 50_000, 62_500, 83_300, 95_200, 100_000, 125_000, 250_000, 400_000, 500_000, 800_000,
    1_000_000,
  ]);
});

test("timingError names the field out of limits", () => {
  expect(timingError({ prescaler: 15, seg1: 12, seg2: 3, sjw: 1 })).toBeNull();
  expect(timingError({ prescaler: 0, seg1: 12, seg2: 3, sjw: 1 })).toBe("Делитель: от 1 до 512");
  expect(timingError({ prescaler: 15, seg1: 300, seg2: 3, sjw: 1 })).toBe("Seg1: от 1 до 256");
  expect(timingError({ prescaler: 15, seg1: 12, seg2: 3, sjw: 4 })).toBe("Sync.Jump Width не больше Seg2");
});
