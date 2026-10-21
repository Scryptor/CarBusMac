// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ui } from "../src/app/ui";
import { DOCK_MIN, Workspace, clampDock } from "../src/app/Workspace";

// рабочая область окна 1366×650: 650 − меню 28 − тулбар 38 − статусбар 24
const WS_650 = 560;
let wsHeight = WS_650;
let spy: { mockRestore: () => void };
beforeEach(() => {
  wsHeight = WS_650;
  spy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("workspace") ? wsHeight : 0;
  });
  ui.view.value = "main";
  ui.dockOpen.value = true;
});
afterEach(() => {
  spy.mockRestore();
  cleanup();
  ui.dockHeight.value = 270;
});

const dockHeight = (c: Element) => parseFloat(c.querySelector<HTMLElement>(".dock")!.style.height);

test("clampDock keeps the dock between its content minimum and 65 % of the work area", () => {
  expect(clampDock(270, WS_650)).toBe(270);
  expect(clampDock(600, WS_650)).toBe(Math.round(WS_650 * 0.65));
  expect(clampDock(100, WS_650)).toBe(DOCK_MIN);
  expect(clampDock(300, 200)).toBe(DOCK_MIN); // крошечное окно: содержимое дока важнее
  expect(DOCK_MIN).toBeGreaterThanOrEqual(190); // вкладка + таблица + редактор с «Удалить»
});

test("a dock height saved on a big screen is limited when the app opens in a small window", () => {
  ui.dockHeight.value = 600;
  const { container } = render(<Workspace />);
  expect(dockHeight(container)).toBe(Math.round(WS_650 * 0.65));
  expect(ui.dockHeight.value).toBe(600); // сохранённое значение не портим — на большом экране вернётся
});

test("the limit follows the window size", () => {
  ui.dockHeight.value = 600;
  wsHeight = 1100;
  const { container } = render(<Workspace />);
  expect(dockHeight(container)).toBe(600);
  wsHeight = WS_650;
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  expect(dockHeight(container)).toBe(Math.round(WS_650 * 0.65));
  act(() => {
    ui.dockHeight.value = 120;
  });
  expect(dockHeight(container)).toBe(DOCK_MIN);
});
