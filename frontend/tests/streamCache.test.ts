import { expect, test } from "vitest";
import { StreamCache } from "../src/features/stream/streamCache";
import type { FrameRowJson } from "../src/core/types";

const rows = (start: number, n: number): FrameRowJson[] =>
  Array.from({ length: n }, (_, k) => ({
    i: start + k, t: (start + k) / 100, ch: 1, dir: "rx", id: 0x100, ext: false, rtr: false, dlc: 1, data: "00", marker: null,
  }));

test("missingPages lists uncached pages once and skips pending", () => {
  const c = new StreamCache(100);
  expect(c.missingPages(0, 250)).toEqual([0, 1, 2]);
  c.markPending(1);
  expect(c.missingPages(0, 250)).toEqual([0, 2]);
  c.put(0, rows(0, 100));
  expect(c.missingPages(0, 250)).toEqual([2]);
  expect(c.get(42)?.i).toBe(42);
  expect(c.get(150)).toBeUndefined();
});

test("tail keeps follow window and fills rows without full fetch", () => {
  const c = new StreamCache(100);
  c.applyTail(950, rows(950, 50));
  expect(c.get(999)?.i).toBe(999);
  expect(c.get(949)).toBeUndefined();
  // хвост заполняет страницу 9 частично — её всё равно надо дочитать
  expect(c.missingPages(900, 1000)).toEqual([9]);
});

test("reset drops cached rows and pending pages", () => {
  const c = new StreamCache(100);
  c.put(0, rows(0, 100));
  c.markPending(1);
  c.reset();
  expect(c.get(0)).toBeUndefined();
  expect(c.missingPages(0, 150)).toEqual([0, 1]);
});

test("put of a short last page marks it complete up to total", () => {
  const c = new StreamCache(100);
  c.put(100, rows(100, 30));
  expect(c.missingPages(100, 130, 130)).toEqual([]);
  expect(c.missingPages(100, 160, 160)).toEqual([1]);
});

test("trimAround keeps a window around the visible rows once the cache grows big", () => {
  const c = new StreamCache(100);
  c.put(0, rows(0, 1000));
  c.trimAround(500, 520); // небольшой кэш не трогаем
  expect(c.size).toBe(1000);
  c.put(0, rows(0, 30000));
  c.trimAround(25000, 25050); // остаются видимые строки и по 10 страниц с каждой стороны
  expect(c.size).toBe(25050 + 1000 - (25000 - 1000));
  expect(c.get(25010)?.i).toBe(25010);
  expect(c.get(23999)).toBeUndefined();
  expect(c.get(0)).toBeUndefined();
});
