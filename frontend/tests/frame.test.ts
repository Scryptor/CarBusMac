import { test, expect } from "vitest";
import { parseHexBytes, parseCanId, encodeTxFrame } from "../src/lib/frame";

test("parseCanId enforces 11-bit range", () => {
  expect(parseCanId("7FF", false)).toBe(0x7ff);
  expect(() => parseCanId("800", false)).toThrow();      // >0x7FF для 11-бит
});

test("parseCanId enforces 29-bit range", () => {
  expect(parseCanId("1FFFFFFF", true)).toBe(0x1fffffff);
  expect(() => parseCanId("20000000", true)).toThrow();
});

test("parseHexBytes validates and parses", () => {
  expect(parseHexBytes("02 3e 00")).toEqual([2, 62, 0]);
  expect(parseHexBytes("")).toEqual([]);
  expect(() => parseHexBytes("zz")).toThrow();
  expect(() => parseHexBytes("0")).toThrow();            // нечётная длина
});

test("encodeTxFrame builds a command frame", () => {
  const f = encodeTxFrame({ channel: 1, id: "7E0", data: "02 3e 00", extended: false });
  expect(f).toMatchObject({ channel: 1, can_id: 0x7e0, data: "023e00", extended: false });
});
