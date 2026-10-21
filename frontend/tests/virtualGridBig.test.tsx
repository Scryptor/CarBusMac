// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MAX_BODY_PX } from "../src/ui/grid/gridMath";
import { VirtualGrid, type GridController } from "../src/ui/grid/VirtualGrid";

// окно таблицы 426 px: 26 px липкой шапки + 400 px строк
let spy: { mockRestore: () => void };
beforeEach(() => {
  spy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(426);
});
afterEach(() => {
  spy.mockRestore();
  cleanup();
});

const cols = [{ key: "n", title: "N", width: 80, render: (r: { n: number }) => r.n }];
const ROWS = 5_000_000;

function big(rowCount: number, follow = false) {
  let ctl: GridController | null = null;
  const props = {
    gridId: "big",
    ariaLabel: "t",
    columns: cols,
    getRow: (i: number) => ({ n: i }),
    controller: (c: GridController) => (ctl = c),
    follow,
  };
  const r = render(<VirtualGrid<{ n: number }> {...props} rowCount={rowCount} />);
  const grid = r.container.querySelector<HTMLElement>(".grid")!;
  /** верх строки i относительно видимой области (px); NaN — строка не нарисована
   * (не null: toBeCloseTo считает null нулём и проверка прошла бы впустую) */
  const offset = (i: number) => {
    const row = r.container.querySelector<HTMLElement>(`[aria-rowindex="${i + 1}"]`);
    return row ? parseFloat(row.style.top) - grid.scrollTop : NaN;
  };
  return { ...r, grid, offset, ctl: () => ctl!, rerenderWith: (n: number) => r.rerender(<VirtualGrid<{ n: number }> {...props} rowCount={n} />) };
}

test("5 000 000 rows: the body fits the browser limit and the last row is reachable", () => {
  const g = big(ROWS);
  const bodyH = parseFloat(g.container.querySelector<HTMLElement>(".grid-body")!.style.height);
  expect(bodyH).toBeLessThanOrEqual(MAX_BODY_PX);
  act(() => g.ctl().scrollToRow(ROWS - 1));
  expect(g.offset(ROWS - 1)).toBeCloseTo(400 - 22, 3); // последняя строка у нижнего края
  const last = g.container.querySelector<HTMLElement>(`[aria-rowindex="${ROWS}"]`)!;
  expect(parseFloat(last.style.top) + 22).toBeLessThanOrEqual(bodyH + 1e-6);
  act(() => g.ctl().scrollToRow(2_500_000));
  expect(g.offset(2_500_000)).toBeCloseTo(0, 3); // выше окна — встаёт к верхнему краю
});

test("arrow keys and PgDn move exactly one row / one page in a huge table", async () => {
  const { Selection } = await import("../src/ui/grid/selection");
  const sel = new Selection();
  const r = render(
    <VirtualGrid<{ n: number }> gridId="big" ariaLabel="t" columns={cols} rowCount={ROWS} getRow={(i) => ({ n: i })} selection={sel} />,
  );
  const grid = r.container.querySelector<HTMLElement>(".grid")!;
  const offset = (i: number) => parseFloat(r.container.querySelector<HTMLElement>(`[aria-rowindex="${i + 1}"]`)!.style.top) - grid.scrollTop;
  sel.click(3_000_000);
  fireEvent.keyDown(grid, { key: "ArrowDown" });
  expect(sel.focus).toBe(3_000_001);
  expect(offset(3_000_001)).toBeCloseTo(400 - 22, 3);
  fireEvent.keyDown(grid, { key: "PageDown" });
  const page = Math.floor(400 / 22) - 1;
  expect(sel.focus).toBe(3_000_001 + page);
  expect(offset(3_000_001 + page)).toBeCloseTo(400 - 22, 3);
  fireEvent.keyDown(grid, { key: "End" });
  expect(sel.focus).toBe(ROWS - 1);
  expect(offset(ROWS - 1)).toBeCloseTo(400 - 22, 3);
});

test("the wheel scrolls a huge table at normal speed", () => {
  const g = big(ROWS);
  act(() => g.ctl().scrollToRow(1000));
  const before = g.offset(1000)!;
  act(() => {
    g.grid.dispatchEvent(new WheelEvent("wheel", { deltaY: 220, bubbles: true, cancelable: true }));
  });
  expect(g.offset(1000)).toBeCloseTo(before - 220, 3); // ровно 10 строк, а не 10·k
});

test("new rows do not shift the rows the user is reading in a huge table", () => {
  const g = big(3_000_000, true); // с автоследованием таблица открывается в конце
  act(() => g.ctl().scrollToRow(1_000_000)); // строка выше окна — встаёт к верхнему краю
  fireEvent.scroll(g.grid); // браузер прислал бы scroll: пользователь уже не внизу
  expect(g.offset(1_000_000)).toBeCloseTo(0, 3);
  act(() => g.rerenderWith(3_100_000));
  expect(g.offset(1_000_000)).toBeCloseTo(0, 3);
  // внизу — автоследование за концом
  act(() => g.ctl().scrollToRow(3_099_999));
  fireEvent.scroll(g.grid);
  act(() => g.rerenderWith(3_200_000));
  expect(g.offset(3_199_999)).toBeCloseTo(400 - 22, 3);
});

// «Перейти к метке» во время записи: флаг «у конца» должен смениться сразу, а не со
// следующим событием scroll — иначе новые кадры тут же утягивают таблицу обратно в конец
for (const [rows, label] of [
  [1_000, "small table"],
  [3_000_000, "huge (scaled) table"],
] as const) {
  test(`scrollToRow during recording stops auto-follow at once (${label})`, () => {
    const g = big(rows, true); // открыта в конце, автоследование
    act(() => g.ctl().scrollToRow(100)); // события scroll ещё не было
    expect(g.offset(100)).toBeCloseTo(0, 3);
    act(() => g.rerenderWith(rows + 10)); // пришли новые кадры
    expect(g.offset(100)).toBeCloseTo(0, 3);
    // переход к последней строке снова включает автоследование — тоже сразу
    act(() => g.ctl().scrollToRow(rows + 9));
    act(() => g.rerenderWith(rows + 20));
    expect(g.offset(rows + 19)).toBeCloseTo(400 - 22, 3);
  });
}
