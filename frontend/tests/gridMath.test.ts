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

// Chrome не даёт элементу быть выше 33 554 432 px: при 22 px на строку дальше строки
// 1 525 201 не прокрутить. Тело ограничено MAX_BODY_PX, прокрутка пересчитывается.
const CHROME_MAX_PX = 33_554_432;

test("small tables are not scaled", async () => {
  const { scrollGeom, physToVirt, virtToPhys } = await import("../src/ui/grid/gridMath");
  const g = scrollGeom(1000, 22, 400);
  expect(g).toMatchObject({ total: 22_000, body: 22_000, k: 1 });
  expect(physToVirt(1234, g)).toBe(1234);
  expect(virtToPhys(1234, g)).toBe(1234);
});

test("5 000 000 rows: body stays under the browser limit, every row is reachable", async () => {
  const { MAX_BODY_PX, scrollGeom, physToVirt, virtToPhys, isAtBottom, scrollTopForRow, visibleRange } = await import(
    "../src/ui/grid/gridMath"
  );
  const rows = 5_000_000;
  const rowH = 22;
  const vp = 400; // тело без липкой шапки
  const g = scrollGeom(rows, rowH, vp);
  expect(g.total).toBe(rows * rowH);
  expect(g.body).toBeLessThanOrEqual(MAX_BODY_PX);
  expect(g.body).toBeLessThan(CHROME_MAX_PX);
  expect(g.k).toBeGreaterThan(1);
  // ползунок в самом низу — видна последняя строка, её низ совпадает с низом окна
  const end = physToVirt(g.maxPhys, g);
  expect(end).toBe(g.total - vp);
  expect(visibleRange(end, vp, rowH, rows).last).toBe(rows);
  expect(rows * rowH - end).toBe(vp);
  expect(isAtBottom(end, vp, g.total, rowH)).toBe(true);
  expect(isAtBottom(physToVirt(g.maxPhys - 1000, g), vp, g.total, rowH)).toBe(false);
  // ползунок посередине — середина таблицы
  const mid = visibleRange(physToVirt(g.maxPhys / 2, g), vp, rowH, rows);
  expect(Math.abs(mid.first - rows / 2)).toBeLessThan(50);
  // переход к строке 4 000 000 (метка, PgDn, End): позиция в пределах прокрутки элемента
  const v = scrollTopForRow(4_000_000, 0, vp, rowH);
  const phys = virtToPhys(v, g);
  expect(phys).toBeGreaterThan(0);
  expect(phys).toBeLessThanOrEqual(g.maxPhys);
  expect(4_000_000 * rowH - v).toBe(vp - rowH); // строка — последняя видимая
  // конец таблицы (End) — ровно максимум прокрутки элемента
  expect(virtToPhys(scrollTopForRow(rows - 1, 0, vp, rowH), g)).toBeCloseTo(g.maxPhys, 6);
});

test("rows are drawn at their table offset relative to the visible area, inside the body", async () => {
  const { scrollGeom, physToVirt, rowTop, visibleRange } = await import("../src/ui/grid/gridMath");
  const rows = 5_000_000;
  const rowH = 27; // шрифт таблиц 16 px
  const vp = 600;
  const g = scrollGeom(rows, rowH, vp);
  for (const phys of [0, 1, g.maxPhys / 3, g.maxPhys - 1, g.maxPhys]) {
    const virt = physToVirt(phys, g);
    // видимая область целиком внутри тела (выступ строк за тело — вне её, тело их обрезает)
    expect(phys).toBeGreaterThanOrEqual(0);
    expect(phys + vp).toBeLessThanOrEqual(g.body + 1e-6);
    const { first, last } = visibleRange(virt, vp, rowH, rows);
    for (let i = first; i < last; i++) {
      // строка стоит там же, где стояла бы в «полной» таблице, относительно окна
      expect(rowTop(i, rowH, phys, virt) - phys).toBeCloseTo(i * rowH - virt, 4);
    }
    // окно накрыто строками целиком: первая нарисованная не ниже верха, последняя не выше низа
    expect(rowTop(first, rowH, phys, virt) - phys).toBeLessThanOrEqual(0);
    expect(rowTop(last - 1, rowH, phys, virt) - phys + rowH).toBeGreaterThanOrEqual(vp - 1e-6);
  }
  // без масштаба строка стоит на своём месте
  const small = scrollGeom(100, 22, 400);
  expect(rowTop(10, 22, 50, physToVirt(50, small))).toBe(220);
});
