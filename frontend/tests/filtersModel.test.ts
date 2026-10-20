import { expect, test } from "vitest";
import { describeExclusion, describeRange, parseExcludeList, rangeWithExcludeList } from "../src/features/filters/filtersModel";

const range = { id: "r1", channel: 1, enabled: true, start: 0x100, end: 0x1ff, exclusions: [] };

test("describeRange uses desktop wording", () => {
  expect(describeRange(range)).toBe("Канал 1: С 100 по 1FF");
  expect(describeRange({ ...range, channel: 2, start: 0x18da0000, end: 0x18daffff })).toBe("Канал 2: С 18DA0000 по 18DAFFFF");
});

test("describeExclusion hides mask in simple mode", () => {
  expect(describeExclusion({ enabled: true, can_id: 0x120, mask: 0x7f0 }, false)).toBe("Исключить Id: 120 / Маска: 7F0");
  expect(describeExclusion({ enabled: true, can_id: 0x120, mask: 0x7ff }, true)).toBe("Исключить Id: 120");
});

test("parseExcludeList accepts comma separated hex and rejects junk", () => {
  expect(parseExcludeList("120, 7E8,1aa")).toEqual([0x120, 0x7e8, 0x1aa]);
  expect(parseExcludeList("  ")).toEqual([]);
  expect(() => parseExcludeList("120, zz")).toThrow(/zz/);
});

test("rangeWithExcludeList keeps masks of existing exclusions", () => {
  const r = { ...range, exclusions: [{ enabled: false, can_id: 0x120, mask: 0x7f0 }] };
  const next = rangeWithExcludeList(r, [0x120, 0x150]);
  expect(next.exclusions).toEqual([
    { enabled: false, can_id: 0x120, mask: 0x7f0 },
    { enabled: true, can_id: 0x150, mask: 0x7ff },
  ]);
});
