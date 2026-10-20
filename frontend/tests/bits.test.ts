import { test, expect } from "vitest";
import { byteToBits, changedByteIndices, diffBits } from "../src/lib/bits";

test("byteToBits weights MSB first (x80..x01)", () => {
  expect(byteToBits(0x81)).toEqual([true, false, false, false, false, false, false, true]);
  expect(byteToBits(0x00)).toEqual([false, false, false, false, false, false, false, false]);
});

test("changedByteIndices from mask", () => {
  expect(changedByteIndices(0b101)).toEqual([0, 2]);
  expect(changedByteIndices(0)).toEqual([]);
});

test("diffBits returns MSB-first positions that changed", () => {
  expect(diffBits(0x00, 0x81)).toEqual([0, 7]);
  expect(diffBits(0xff, 0xff)).toEqual([]);
});
