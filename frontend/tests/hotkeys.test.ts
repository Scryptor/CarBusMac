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

const kc = (key: string, code: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
  normalizeKey({ key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

test("letter and digit hotkeys work in the Russian layout (physical key from e.code)", () => {
  expect(kc("а", "KeyF", { ctrlKey: true })).toBe("Ctrl+F");
  expect(kc("т", "KeyN", { ctrlKey: true })).toBe("Ctrl+N");
  expect(kc("щ", "KeyO", { ctrlKey: true })).toBe("Ctrl+O");
  expect(kc("ы", "KeyS", { ctrlKey: true })).toBe("Ctrl+S");
  expect(kc("Ы", "KeyS", { ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+S");
  expect(kc("с", "KeyC", { ctrlKey: true })).toBe("Ctrl+C");
  expect(kc("!", "Digit1", { ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+1");
  // F-клавиши, стрелки и именованные клавиши — по key
  expect(kc("F5", "F5", { shiftKey: true })).toBe("Shift+F5");
  expect(kc("ArrowDown", "ArrowDown", { ctrlKey: true })).toBe("Ctrl+ArrowDown");
  expect(kc("Insert", "Insert")).toBe("Insert");
  expect(kc("Enter", "NumpadEnter", { ctrlKey: true })).toBe("Ctrl+Enter");
  // латинская раскладка не QWERTY (AZERTY): буква — та, что на клавише, а не её позиция
  expect(kc("a", "KeyQ", { ctrlKey: true })).toBe("Ctrl+A");
});

test("checkboxes and radios don't block hotkeys; text fields do; a list keeps only its own keys", () => {
  const el = (tagName: string, type?: string) => ({ tagName, type, isContentEditable: false }) as unknown as EventTarget;
  // флажок «29 bit» в фокусе — сочетания окна работают
  expect(shouldHandle("Ctrl+F", el("INPUT", "checkbox"))).toBe(true);
  expect(shouldHandle("Ctrl+N", el("INPUT", "radio"))).toBe(true);
  expect(shouldHandle("Insert", el("INPUT", "checkbox"))).toBe(true);
  expect(shouldHandle("Ctrl+Enter", el("INPUT", "checkbox"))).toBe(true);
  expect(shouldHandle("Ctrl+N", el("BUTTON"))).toBe(true);
  // текстовые поля — только F-клавиши (Ctrl+буква на маке двигает курсор)
  expect(shouldHandle("Ctrl+N", el("INPUT", "text"))).toBe(false);
  expect(shouldHandle("Ctrl+N", el("INPUT", "number"))).toBe(false);
  expect(shouldHandle("Ctrl+N", el("INPUT", "search"))).toBe(false);
  expect(shouldHandle("Insert", el("INPUT", "text"))).toBe(false);
  expect(shouldHandle("Ctrl+N", el("TEXTAREA"))).toBe(false);
  expect(shouldHandle("F5", el("TEXTAREA"))).toBe(true);
  expect(shouldHandle("Ctrl+N", { tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(false);
  // выпадающий список: стрелки, листание и поиск по буквам — его; Ctrl-сочетания — окна
  expect(shouldHandle("Ctrl+F", el("SELECT"))).toBe(true);
  expect(shouldHandle("Ctrl+ArrowDown", el("SELECT"))).toBe(true);
  expect(shouldHandle("Insert", el("SELECT"))).toBe(true);
  expect(shouldHandle("F3", el("SELECT"))).toBe(true);
  expect(shouldHandle("ArrowDown", el("SELECT"))).toBe(false);
  expect(shouldHandle("PageDown", el("SELECT"))).toBe(false);
  expect(shouldHandle("A", el("SELECT"))).toBe(false);
  expect(shouldHandle(" ", el("SELECT"))).toBe(false);
});
