// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { VirtualGrid } from "../src/ui/grid/VirtualGrid";

afterEach(() => cleanup());

const cols = [{ key: "n", title: "N", width: 60, render: (r: { n: number }) => r.n }];

test("grid asks for its rows again when the data version changes", () => {
  const onRange = vi.fn();
  const props = { gridId: "t", ariaLabel: "t", columns: cols, rowCount: 100, getRow: () => undefined, onRange };
  const { rerender } = render(<VirtualGrid<{ n: number }> {...props} version={1} />);
  const before = onRange.mock.calls.length;
  expect(before).toBeGreaterThan(0);
  rerender(<VirtualGrid<{ n: number }> {...props} version={1} />);
  expect(onRange.mock.calls.length).toBe(before);
  rerender(<VirtualGrid<{ n: number }> {...props} version={2} />);
  expect(onRange.mock.calls.length).toBe(before + 1);
});

test("a fill column takes the free width of the grid", () => {
  const spy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  try {
    const columns = [
      { key: "a", title: "A", width: 100, render: () => "" },
      { key: "b", title: "B", width: 200, fill: true, render: () => "" },
    ];
    const { container } = render(
      <VirtualGrid<{ n: number }> gridId="fill" ariaLabel="t" columns={columns} rowCount={0} getRow={() => undefined} />,
    );
    const heads = [...container.querySelectorAll<HTMLElement>(".gh")];
    expect(heads.map((h) => h.style.width)).toEqual(["100px", "900px"]);
  } finally {
    spy.mockRestore();
  }
});

test("shift/ctrl clicks select rows without selecting page text", async () => {
  const { fireEvent } = await import("@testing-library/preact");
  const { Selection } = await import("../src/ui/grid/selection");
  const spy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  try {
    const sel = new Selection();
    const { container } = render(
      <VirtualGrid<{ n: number }>
        gridId="sel"
        ariaLabel="t"
        columns={cols}
        rowCount={10}
        getRow={(i) => ({ n: i })}
        selection={sel}
        multi
      />,
    );
    const rows = container.querySelectorAll<HTMLElement>(".gr");
    expect(fireEvent.mouseDown(rows[1])).toBe(true); // обычный клик — поведение браузера не трогаем
    expect(fireEvent.mouseDown(rows[4], { shiftKey: true })).toBe(false);
    expect(fireEvent.mouseDown(rows[6], { ctrlKey: true })).toBe(false);
    expect(sel.selected()).toEqual([1, 2, 3, 4, 6]);
  } finally {
    spy.mockRestore();
  }
});

test("column widths grow with the table font so data is not cut", async () => {
  const { gridScale } = await import("../src/ui/grid/VirtualGrid");
  gridScale.value = 16 / 13;
  try {
    const columns = [{ key: "data", title: "Данные", width: 130, render: () => "" }];
    const { container } = render(
      <VirtualGrid<{ n: number }> gridId="scale" ariaLabel="t" columns={columns} rowCount={0} getRow={() => undefined} />,
    );
    expect(container.querySelector<HTMLElement>(".gh")!.style.width).toBe("160px");
  } finally {
    gridScale.value = 1;
  }
});
