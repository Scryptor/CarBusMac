import { expect, test } from "vitest";
import { fmtAscii, fmtData, fmtFlags, fmtId, fmtPeriod, fmtTime, parseHexByte, parseHexId } from "../src/core/format";

test("fmtId hex/dec widths", () => {
  expect(fmtId(0x123, false, true)).toBe("123");
  expect(fmtId(0x1a, false, true)).toBe("01A");
  expect(fmtId(0x123, true, true)).toBe("00000123");
  expect(fmtId(291, false, false)).toBe("291");
});

test("fmtTime uses comma and 3 decimals", () => {
  expect(fmtTime(12.4531)).toBe("12,453");
  expect(fmtTime(0)).toBe("0,000");
  expect(fmtTime(3600.0004)).toBe("3600,000");
});

test("fmtPeriod formats ms with comma, empty for null", () => {
  expect(fmtPeriod(19.9994)).toBe("19,999");
  expect(fmtPeriod(null)).toBe("");
});

test("fmtData splits hex into upper-case byte strings", () => {
  expect(fmtData("023e00")).toEqual(["02", "3E", "00"]);
  expect(fmtData("")).toEqual([]);
});

test("fmtAscii replaces non-printables", () => {
  expect(fmtAscii("41420a7f20")).toBe("AB.. ");
});

test("fmtFlags mirrors desktop flag column", () => {
  expect(fmtFlags({ rtr: false, fd: false, brs: false })).toBe("CAN");
  expect(fmtFlags({ rtr: true, fd: false, brs: false })).toBe("CAN RTR");
  expect(fmtFlags({ rtr: false, fd: true, brs: true })).toBe("FD BRS");
});

test("parseHexId validates range and syntax", () => {
  expect(parseHexId("7E0", false)).toBe(0x7e0);
  expect(parseHexId(" 0x18daf110 ", true)).toBe(0x18daf110);
  expect(() => parseHexId("800", false)).toThrow(/11 бит/);
  expect(() => parseHexId("zz", false)).toThrow(/ID/);
  expect(() => parseHexId("", false)).toThrow(/ID/);
});

test("parseHexByte accepts 1-2 hex digits and empty when allowed", () => {
  expect(parseHexByte("f")).toBe(0x0f);
  expect(parseHexByte("A5")).toBe(0xa5);
  expect(parseHexByte("", true)).toBeNull();
  expect(() => parseHexByte("", false)).toThrow();
  expect(() => parseHexByte("100")).toThrow();
});
