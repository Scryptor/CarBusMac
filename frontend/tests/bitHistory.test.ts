import { expect, test } from "vitest";
import { BitHistory } from "../src/features/monitor/bitHistory";

test("first update does not highlight anything", () => {
  const h = new BitHistory();
  h.update([0xff, 0x00], 10);
  expect(h.lit(10, 2000)).toEqual([[false, false, false, false, false, false, false, false],
    [false, false, false, false, false, false, false, false]]);
});

test("bit change held for hold time", () => {
  const h = new BitHistory();
  h.update([0x00], 0);
  h.update([0x81], 100); // x80 и x01 включились
  const at = (now: number) => h.lit(now, 2000)[0];
  expect(at(2099)).toEqual([true, false, false, false, false, false, false, true]);
  expect(at(2101)).toEqual([false, false, false, false, false, false, false, false]);
  expect(h.start(0, 0)).toBe(100);
});

test("unchanged update keeps earlier starts and longer payload extends", () => {
  const h = new BitHistory();
  h.update([0x01], 0);
  h.update([0x00], 50);
  h.update([0x00, 0x10], 60);
  expect(h.start(0, 7)).toBe(50);
  expect(h.start(1, 3)).toBe(-Infinity); // новый байт без «прошлого» не подсвечиваем
});
