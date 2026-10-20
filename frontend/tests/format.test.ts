import { test, expect } from "vitest";
import { formatId, formatData } from "../src/lib/format";

test("formatId distinguishes 11 vs 29 bit", () => {
  expect(formatId(0x123, false)).toBe("0x123");
  expect(formatId(0x123, true)).toBe("0x00000123");
});

test("formatData is space-separated two-hex bytes", () => {
  expect(formatData([0x02, 0x3e, 0x00])).toBe("02 3E 00");
  expect(formatData([])).toBe("");
});
