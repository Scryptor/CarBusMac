// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ContextMenuLayer, closeContextMenu, openContextMenu, popup } from "../src/ui/ContextMenu";
import { VirtualGrid, type GridController } from "../src/ui/grid/VirtualGrid";

let spy: { mockRestore: () => void };
beforeEach(() => {
  spy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(426);
});
afterEach(() => {
  closeContextMenu();
  spy.mockRestore();
  cleanup();
  document.body.innerHTML = "";
});

// act: слушатели слой ставит в эффекте после отрисовки — дождаться его
test("the context menu closes when the user scrolls something, not when the menu itself scrolls", () => {
  render(<ContextMenuLayer />);
  act(() => openContextMenu(10, 10, [{ label: "Пункт", run: () => {} }]));
  const menu = screen.getByRole("menu");
  fireEvent.scroll(menu);
  expect(popup.value).not.toBeNull();
  const list = document.createElement("div");
  document.body.appendChild(list);
  list.scrollTop = 40;
  fireEvent.scroll(list);
  expect(popup.value).toBeNull();
});

test("the wheel outside the menu closes it", () => {
  render(<ContextMenuLayer />);
  act(() => openContextMenu(10, 10, [{ label: "Пункт", run: () => {} }]));
  const menu = screen.getByRole("menu");
  fireEvent.wheel(menu, { deltaY: 30 });
  expect(popup.value).not.toBeNull();
  fireEvent.wheel(document.body, { deltaY: 30 });
  expect(popup.value).toBeNull();
});

test("auto-follow of a recording stream (the grid scrolls itself) keeps the menu open", () => {
  let ctl: GridController | null = null;
  const cols = [{ key: "n", title: "N", width: 80, render: (r: { n: number }) => r.n }];
  const { container } = render(
    <>
      <VirtualGrid<{ n: number }> gridId="s" ariaLabel="t" columns={cols} rowCount={500} getRow={(i) => ({ n: i })} controller={(c) => (ctl = c)} />
      <ContextMenuLayer />
    </>,
  );
  act(() => openContextMenu(10, 10, [{ label: "Добавить метку", run: () => {} }]));
  screen.getByRole("menu");
  const grid = container.querySelector<HTMLElement>(".grid")!;
  act(() => ctl!.scrollToRow(499)); // так прокручивает автоследование и переход к строке
  fireEvent.scroll(grid);
  expect(popup.value).not.toBeNull();
  grid.scrollTop = 100; // а это уже пользователь
  fireEvent.scroll(grid);
  expect(popup.value).toBeNull();
});
