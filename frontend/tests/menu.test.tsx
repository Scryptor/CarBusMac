// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test } from "vitest";
import { clearActions } from "../src/core/actions";
import { ContextMenuLayer, closeContextMenu, openContextMenu, popup } from "../src/ui/ContextMenu";

beforeEach(() => clearActions());
afterEach(() => {
  closeContextMenu();
  cleanup();
  document.body.innerHTML = "";
});

const activeText = (menu: HTMLElement) => menu.querySelector(".menu-item.active")?.textContent ?? "";

test("ArrowRight opens only submenus; the submenu takes focus, ArrowLeft returns to the parent", async () => {
  const ran: string[] = [];
  render(<ContextMenuLayer />);
  openContextMenu(10, 10, [
    { label: "Первый", run: () => ran.push("first") },
    { separator: true },
    { label: "Ещё", items: [{ label: "Вложенный", run: () => ran.push("sub") }, { label: "Второй", run: () => ran.push("sub2") }] },
  ]);
  const menu = await screen.findByRole("menu");
  expect(document.activeElement).toBe(menu);
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(activeText(menu)).toContain("Первый");
  fireEvent.keyDown(menu, { key: "ArrowRight" }); // обычный пункт — ничего не выполняется
  expect(ran).toEqual([]);
  expect(popup.value).not.toBeNull();
  fireEvent.keyDown(menu, { key: "ArrowDown" }); // разделитель пропущен
  expect(activeText(menu)).toContain("Ещё");
  fireEvent.keyDown(menu, { key: "ArrowRight" });
  let menus = screen.getAllByRole("menu");
  expect(menus).toHaveLength(2);
  expect(document.activeElement).toBe(menus[1]);
  expect(activeText(menus[1])).toContain("Вложенный");
  fireEvent.keyDown(menus[1], { key: "ArrowDown" });
  expect(activeText(menus[1])).toContain("Второй");
  fireEvent.keyDown(menus[1], { key: "ArrowLeft" }); // закрывает только подменю
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  expect(document.activeElement).toBe(menu);
  expect(popup.value).not.toBeNull();
  fireEvent.keyDown(menu, { key: "Enter" }); // Enter на подменю тоже открывает его
  menus = screen.getAllByRole("menu");
  expect(document.activeElement).toBe(menus[1]);
  fireEvent.keyDown(menus[1], { key: "Enter" });
  expect(ran).toEqual(["sub"]);
  expect(popup.value).toBeNull();
});

test("Escape in a submenu closes the whole menu and focus goes back where it was", async () => {
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  render(<ContextMenuLayer />);
  openContextMenu(10, 10, [{ label: "Ещё", items: [{ label: "Пункт", run: () => {} }] }]);
  const menu = await screen.findByRole("menu");
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  fireEvent.keyDown(menu, { key: "ArrowRight" });
  fireEvent.keyDown(screen.getAllByRole("menu")[1], { key: "Escape" });
  expect(popup.value).toBeNull();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(opener);
});
