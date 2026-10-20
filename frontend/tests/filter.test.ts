import { test, expect } from "vitest";
import { matchIdFilter } from "../src/lib/idfilter";

test("range filter from/to inclusive", () => {
  expect(matchIdFilter(0x100, { from: 0x100, to: 0x200 })).toBe(true);
  expect(matchIdFilter(0x090, { from: 0x100, to: 0x200 })).toBe(false);
});

test("empty spec matches everything", () => {
  expect(matchIdFilter(0x7ff, {})).toBe(true);
});

test("exclude inverts the range", () => {
  expect(matchIdFilter(0x150, { from: 0x100, to: 0x200, exclude: true })).toBe(false);
  expect(matchIdFilter(0x050, { from: 0x100, to: 0x200, exclude: true })).toBe(true);
});
