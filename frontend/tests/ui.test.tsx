// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test } from "vitest";
import { clearActions, registerActions } from "../src/core/actions";
import { ContextMenuLayer, closeContextMenu, openContextMenu } from "../src/ui/ContextMenu";
import { Dialog } from "../src/ui/Dialog";
import { ByteCells } from "../src/ui/Fields";

beforeEach(() => clearActions());
afterEach(() => {
  closeContextMenu();
  cleanup();
});

test("context menu renders separators and disabled items, runs enabled item and closes", async () => {
  let ran = 0;
  registerActions([
    { id: "a", label: "Очистить таблицу", shortcut: "Ctrl+N", run: () => ran++ },
    { id: "b", label: "Битовая карта", enabled: () => false, run: () => {} },
  ]);
  render(<ContextMenuLayer />);
  openContextMenu(10, 10, [{ action: "a" }, { separator: true }, { action: "b" }]);
  await screen.findByText("Очистить таблицу");
  expect(document.querySelectorAll(".ctx-sep").length).toBe(1);
  expect(screen.getByText("Битовая карта").closest("[role=menuitem]")?.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("Ctrl+N")).toBeTruthy();
  fireEvent.click(screen.getByText("Очистить таблицу"));
  expect(ran).toBe(1);
  expect(screen.queryByText("Очистить таблицу")).toBeNull();
});

test("dialog closes on Escape and submits on Enter", () => {
  let closed = 0;
  let ok = 0;
  render(
    <Dialog title="Комментарий" onClose={() => closed++} onOk={() => ok++}>
      <input aria-label="c" />
    </Dialog>,
  );
  const input = screen.getByLabelText("c");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(ok).toBe(1);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(closed).toBe(1);
});

test("byte cells parse hex, allow empty don't-care and distribute paste", () => {
  let value: (number | null)[] = [];
  render(<ByteCells count={4} value={[1, null, 3, 4]} allowEmpty onChange={(v) => (value = v)} label="Данные" />);
  const cells = screen.getAllByRole("textbox");
  expect((cells[0] as HTMLInputElement).value).toBe("01");
  expect((cells[1] as HTMLInputElement).value).toBe("");
  fireEvent.input(cells[2], { target: { value: "ff" } });
  expect(value).toEqual([1, null, 0xff, 4]);
  fireEvent.paste(cells[0], { clipboardData: { getData: () => "0A 0B 0C 0D" } });
  expect(value).toEqual([0x0a, 0x0b, 0x0c, 0x0d]);
});

test("menu hides orphan separators around missing actions", async () => {
  registerActions([{ id: "only", label: "Единственный", run: () => {} }]);
  render(<ContextMenuLayer />);
  openContextMenu(10, 10, [
    { separator: true },
    { action: "missing1" },
    { separator: true },
    { action: "only" },
    { separator: true },
    { separator: true },
    { action: "missing2" },
  ]);
  await screen.findByText("Единственный");
  expect(document.querySelectorAll(".ctx-sep").length).toBe(0);
});

test("dialog focuses the first editable field, skipping read-only ones", () => {
  render(
    <Dialog title="Т" onClose={() => {}}>
      <input aria-label="только чтение" readOnly value="1" />
      <input aria-label="правка" value="2" />
    </Dialog>,
  );
  expect(document.activeElement).toBe(screen.getByLabelText("правка"));
});

test("dialog without fields takes focus itself so Escape and Enter work", () => {
  let closed = 0;
  let ok = 0;
  render(
    <Dialog title="Вопрос" onClose={() => closed++} onOk={() => ok++}>
      <p>Удалить?</p>
    </Dialog>,
  );
  const dlg = screen.getByRole("dialog", { name: "Вопрос" });
  expect(document.activeElement).toBe(dlg);
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect([ok, closed]).toEqual([1, 1]);
});

test("switching the view closes an open context menu", async () => {
  const { ui } = await import("../src/app/ui");
  const { popup } = await import("../src/ui/ContextMenu");
  ui.view.value = "main";
  openContextMenu(10, 10, [{ label: "Пункт", run: () => {} }]);
  expect(popup.value).not.toBeNull();
  ui.view.value = "tracer";
  expect(popup.value).toBeNull();
  ui.view.value = "main";
});
