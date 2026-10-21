// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MainMenu } from "../src/app/MainMenu";
import { MainToolbar, toolbarHooks } from "../src/app/MainToolbar";
import { shellActions } from "../src/app/shellActions";
import { clearActions, registerActions } from "../src/core/actions";
import { applyEvent, resetStore } from "../src/core/store";
import { ContextMenuLayer, closeContextMenu, popup } from "../src/ui/ContextMenu";

const status = (state: string) => applyEvent({ type: "status", state, message: "", device_info: null, channels: {} });

beforeEach(() => {
  resetStore();
  clearActions();
  registerActions(shellActions());
  toolbarHooks.channelMenu = () => [{ label: "Канал 1", items: [{ label: "Только слушать", run: () => {} }] }];
});
afterEach(() => {
  closeContextMenu();
  cleanup();
});

test("the main part of «Изменение опций каналов» opens the same menu as its arrow", () => {
  status("opened");
  render(
    <>
      <MainToolbar />
      <ContextMenuLayer />
    </>,
  );
  const main = screen.getByRole("button", { name: "Изменение опций каналов" }) as HTMLButtonElement;
  expect(main.disabled).toBe(false);
  fireEvent.click(main, { detail: 1 });
  expect(popup.value?.owner).toBe("split:channelOptions");
  expect(screen.getByText("Канал 1")).toBeTruthy();
});

test("Enter/Space (click without a mouse) open the split arrow menu and menubar menus", () => {
  status("opened");
  render(
    <>
      <MainMenu />
      <MainToolbar />
      <ContextMenuLayer />
    </>,
  );
  // клик клавиатурой: detail = 0
  fireEvent.click(screen.getByRole("button", { name: "Изменение опций каналов: меню" }), { detail: 0 });
  expect(popup.value?.owner).toBe("split:channelOptions");
  closeContextMenu();
  fireEvent.click(screen.getByRole("button", { name: "?" }), { detail: 0 });
  expect(popup.value?.owner).toBe("menubar:?");
  expect(screen.getByText("О программе")).toBeTruthy();
});

test("the connect button is announced by its visible label", async () => {
  render(<MainToolbar />);
  const idle = screen.getByRole("button", { name: "Подключиться" });
  expect(idle.textContent).toBe("Подключиться");
  status("opened");
  const on = await screen.findByRole("button", { name: "Отключиться" });
  expect(on.textContent).toBe("Отключиться");
});

test("while connecting, the toolbar and the menu offer to cancel — that is what a click does", () => {
  status("opening");
  render(
    <>
      <MainMenu />
      <MainToolbar />
    </>,
  );
  const labels = screen.getAllByText("Отменить подключение");
  expect(labels.length).toBe(2); // пункт строки меню и кнопка тулбара
  expect(screen.queryByText("Подключиться")).toBeNull();
  expect(screen.getByRole("button", { name: "Отменить подключение", pressed: false })).toBeTruthy();
});
