import { expect, test } from "vitest";
import { isAtBottom, scrollTopForRow, visibleRange } from "../src/ui/grid/gridMath";

test("visibleRange clamps and adds overscan", () => {
  expect(visibleRange(0, 220, 22, 1000)).toEqual({ first: 0, last: 16 });
  expect(visibleRange(2200, 220, 22, 1000)).toEqual({ first: 94, last: 116 });
  expect(visibleRange(0, 220, 22, 5)).toEqual({ first: 0, last: 5 });
  expect(visibleRange(99999, 220, 22, 10)).toEqual({ first: 0, last: 10 });
  expect(visibleRange(0, 220, 22, 0)).toEqual({ first: 0, last: 0 });
});

test("scrollTopForRow keeps row visible with minimal scroll", () => {
  // окно 220px, строка 22px: строка 50 ниже окна → прокрутить так, чтобы она стала последней
  expect(scrollTopForRow(50, 0, 220, 22)).toBe(50 * 22 - 220 + 22);
  // строка выше окна → к её верху
  expect(scrollTopForRow(3, 500, 220, 22)).toBe(66);
  // уже видна → без изменений
  expect(scrollTopForRow(25, 500, 220, 22)).toBe(500);
});

test("isAtBottom tolerates one row", () => {
  expect(isAtBottom(1000, 220, 1220, 22)).toBe(true);
  expect(isAtBottom(990, 220, 1220, 22)).toBe(true);
  expect(isAtBottom(900, 220, 1220, 22)).toBe(false);
});
