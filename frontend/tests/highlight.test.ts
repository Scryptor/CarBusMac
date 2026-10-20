import { expect, test } from "vitest";
import { applyChanges, isLit } from "../src/features/monitor/highlight";

const normal = { mark_changed: true, mark_hold_ms: 2000, rare_mode: false, rare_period_ms: 10000 };

test("highlight holds for mark_hold_ms", () => {
  const starts = applyChanges([-Infinity, -Infinity], 0b01, [100, null], 5000, normal);
  expect(starts).toEqual([5000, -Infinity]);
  expect(isLit(starts[0], 6999, 2000)).toBe(true);
  expect(isLit(starts[0], 7001, 2000)).toBe(false);
  expect(isLit(starts[1], 5000, 2000)).toBe(false);
});

test("rare mode ignores frequently changing bytes", () => {
  const rare = { ...normal, rare_mode: true, rare_period_ms: 10000 };
  // байт 0 менялся каждые 50 мс — не подсвечивается; байт 1 стоял 12 с — подсвечивается
  const starts = applyChanges([-Infinity, -Infinity], 0b11, [50, 12000], 100, rare);
  expect(starts).toEqual([-Infinity, 100]);
  // первое появление (stable_ms = null) в режиме редких данных тоже не подсвечиваем
  expect(applyChanges([-Infinity], 0b1, [null], 100, rare)).toEqual([-Infinity]);
});

test("mark_changed off disables highlighting", () => {
  expect(applyChanges([-Infinity], 0b1, [100], 100, { ...normal, mark_changed: false })).toEqual([-Infinity]);
});

test("new bytes extend the marks array", () => {
  expect(applyChanges([], 0b100, [null, null, null], 7, normal)).toEqual([-Infinity, -Infinity, 7]);
});
