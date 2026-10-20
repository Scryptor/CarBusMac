import { expect, test } from "vitest";
import { normalizeKey, shouldHandle } from "../src/core/hotkeys";

const k = (key: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
  normalizeKey({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

test("normalizeKey maps F-keys and modifiers", () => {
  expect(k("F3")).toBe("F3");
  expect(k("F3", { ctrlKey: true })).toBe("Ctrl+F3");
  expect(k("ArrowDown", { ctrlKey: true })).toBe("Ctrl+ArrowDown");
  expect(k("n", { ctrlKey: true })).toBe("Ctrl+N");
  expect(k("S", { ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+S");
  expect(k("F5", { shiftKey: true })).toBe("Shift+F5");
  expect(k("Insert")).toBe("Insert");
  expect(k("Enter", { ctrlKey: true })).toBe("Ctrl+Enter");
  expect(k("Control", { ctrlKey: true })).toBe("");
});

test("Cmd combos are never claimed (browser owns them)", () => {
  expect(k("s", { metaKey: true })).toBe("");
});

test("hotkey in input fires only for F-keys", () => {
  const input = { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
  const div = { tagName: "DIV", isContentEditable: false } as unknown as EventTarget;
  expect(shouldHandle("F5", input)).toBe(true);
  expect(shouldHandle("Ctrl+F3", input)).toBe(true);
  expect(shouldHandle("Ctrl+N", input)).toBe(false);
  expect(shouldHandle("Insert", input)).toBe(false);
  expect(shouldHandle("Ctrl+N", div)).toBe(true);
  expect(shouldHandle("", div)).toBe(false);
});
