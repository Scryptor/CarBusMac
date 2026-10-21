// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test } from "vitest";
import { clearActions, registerActions } from "../src/core/actions";
import { installHotkeys } from "../src/core/hotkeys";

let ran: string[] = [];
let off: () => void = () => {};

beforeEach(() => {
  clearActions();
  ran = [];
  registerActions([
    { id: "filters", label: "Фильтр", shortcut: "Ctrl+F", scope: "main", run: () => ran.push("filters") },
    { id: "add", label: "Добавить", shortcut: "Insert", scope: "main", run: () => ran.push("add") },
  ]);
  off = installHotkeys(() => "main");
});
afterEach(() => {
  off();
  clearActions();
  document.body.innerHTML = "";
});

const press = (target: EventTarget, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

test("Ctrl+F in the Russian layout (key «а») runs the Ctrl+F action", () => {
  press(window, { key: "а", code: "KeyF", ctrlKey: true });
  expect(ran).toEqual(["filters"]);
});

test("after a click on a checkbox window hotkeys still work", () => {
  const box = document.createElement("input");
  box.type = "checkbox";
  document.body.appendChild(box);
  box.focus();
  press(box, { key: "f", code: "KeyF", ctrlKey: true });
  press(box, { key: "Insert", code: "Insert" });
  expect(ran).toEqual(["filters", "add"]);
});

test("a text field keeps Ctrl+letters and plain keys for itself", () => {
  const inp = document.createElement("input");
  document.body.appendChild(inp);
  inp.focus();
  press(inp, { key: "f", code: "KeyF", ctrlKey: true });
  press(inp, { key: "Insert", code: "Insert" });
  expect(ran).toEqual([]);
});
