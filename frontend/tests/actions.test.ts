import { beforeEach, expect, test } from "vitest";
import { clearActions, findByShortcut, getAction, registerActions, runAction } from "../src/core/actions";

beforeEach(() => clearActions());

test("registerActions adds and the returned function removes", () => {
  const off = registerActions([{ id: "a", label: "A", run: () => {} }]);
  expect(getAction("a")?.label).toBe("A");
  off();
  expect(getAction("a")).toBeUndefined();
});

test("disabled action is not run", () => {
  let n = 0;
  registerActions([{ id: "a", label: "A", enabled: () => false, run: () => n++ }]);
  expect(runAction("a")).toBe(false);
  expect(n).toBe(0);
});

test("tracer view overrides main bindings for F5 and Ctrl+N", () => {
  registerActions([
    { id: "record", label: "Запись", shortcut: "F5", scope: "main", run: () => {} },
    { id: "clear", label: "Очистить", shortcut: "Ctrl+N", scope: "main", run: () => {} },
    { id: "bp", label: "Точка", shortcut: "F5", scope: "tracer", run: () => {} },
    { id: "newTrace", label: "Новый", shortcut: "Ctrl+N", scope: "tracer", run: () => {} },
    { id: "connect", label: "Подключиться", shortcut: "F7", scope: "global", run: () => {} },
  ]);
  expect(findByShortcut("F5", "main")?.id).toBe("record");
  expect(findByShortcut("F5", "tracer")?.id).toBe("bp");
  expect(findByShortcut("Ctrl+N", "tracer")?.id).toBe("newTrace");
  expect(findByShortcut("F7", "tracer")?.id).toBe("connect");
  expect(findByShortcut("F9", "main")).toBeUndefined();
});
