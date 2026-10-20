import { expect, test } from "vitest";
import { MonitorStore, rowKey } from "../src/features/monitor/monitorModel";
import type { MonitorRowJson } from "../src/core/types";

const row = (ch: number, id: number, data = "00", extra: Partial<MonitorRowJson> = {}): MonitorRowJson => ({
  ch, id, ext: false, rtr: false, fd: false, brs: false, dlc: data.length / 2, data, count: 1, period_ms: null,
  changed: 0, stable_ms: [], fc: 0, ts: 0, ...extra,
});

const ids = (s: MonitorStore, sort: boolean, group: boolean) => s.order(sort, group).map((k) => s.get(k)!.id);

test("order keeps arrival order, sorts by id, groups by channel", () => {
  const s = new MonitorStore();
  s.apply([row(1, 0x300), row(2, 0x100), row(1, 0x120)], 0, null);
  s.apply([row(2, 0x050)], 0, null);
  expect(ids(s, false, false)).toEqual([0x300, 0x100, 0x120, 0x050]);
  expect(ids(s, true, false)).toEqual([0x050, 0x100, 0x120, 0x300]);
  expect(ids(s, false, true)).toEqual([0x300, 0x120, 0x100, 0x050]);
  expect(ids(s, true, true)).toEqual([0x120, 0x300, 0x050, 0x100]);
});

test("apply updates rows in place and keeps one row per key", () => {
  const s = new MonitorStore();
  s.apply([row(1, 0x10, "01")], 0, null);
  s.apply([row(1, 0x10, "02", { count: 2 })], 0, null);
  expect(s.size).toBe(1);
  expect(s.get(rowKey(1, 0x10, false))!.data).toBe("02");
  expect(s.get(rowKey(1, 0x10, false))!.count).toBe(2);
});

test("reset clears rows and highlight state", () => {
  const s = new MonitorStore();
  s.apply([row(1, 1, "ff", { changed: 1 })], 100, { mark_changed: true, mark_hold_ms: 2000, rare_mode: false, rare_period_ms: 10000 });
  s.reset();
  expect(s.size).toBe(0);
  expect(s.order(false, false)).toEqual([]);
});

test("apply records highlight start per changed byte", () => {
  const s = new MonitorStore();
  const hs = { mark_changed: true, mark_hold_ms: 2000, rare_mode: false, rare_period_ms: 10000 };
  s.apply([row(1, 1, "0102", { changed: 0b10, stable_ms: [null, 50] })], 1000, hs);
  const k = rowKey(1, 1, false);
  expect(s.marks(k)).toEqual([-Infinity, 1000]);
});
