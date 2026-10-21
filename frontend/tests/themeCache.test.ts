// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cachedTheme, rememberTheme } from "../src/core/theme";
import { DEFAULT_SETTINGS } from "../src/core/store";

const root = document.documentElement;
beforeEach(() => {
  localStorage.clear();
  delete root.dataset.theme;
  root.removeAttribute("style");
});
afterEach(() => vi.restoreAllMocks());

test("the applied theme is remembered in the browser; garbage and a missing localStorage are survived", () => {
  rememberTheme({ ...DEFAULT_SETTINGS, theme: "dark", grid_font_size: 16, grid_font: "Menlo" });
  expect(cachedTheme()).toMatchObject({ theme: "dark", grid_font_size: 16, grid_font: "Menlo" });
  localStorage.setItem("carbus:theme", JSON.stringify({ theme: "purple", grid_font_size: "big" }));
  expect(cachedTheme()).toEqual({});
  localStorage.setItem("carbus:theme", "{not json");
  expect(cachedTheme()).toEqual({});
  // данные сайта заблокированы: само обращение к localStorage бросает SecurityError
  const own = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError");
    },
  });
  try {
    expect(() => rememberTheme(DEFAULT_SETTINGS)).not.toThrow();
    expect(cachedTheme()).toEqual({});
  } finally {
    if (own) Object.defineProperty(window, "localStorage", own);
    else delete (window as { localStorage?: Storage }).localStorage;
  }
  expect(cachedTheme()).toEqual({}); // в кэше по-прежнему битый JSON
});

/** Встроенный скрипт index.html — он срабатывает до загрузки приложения. */
function bootScript(): () => void {
  const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  expect(m, "в index.html нет встроенного скрипта темы").not.toBeNull();
  return new Function(m![1]) as () => void;
}

test("index.html applies the remembered theme and table font before the app loads", () => {
  localStorage.setItem("carbus:theme", JSON.stringify({ theme: "dark", grid_font: "Menlo", grid_font_size: 16 }));
  bootScript()();
  expect(root.dataset.theme).toBe("dark");
  expect(root.style.getPropertyValue("--grid-size")).toBe("16px");
  expect(root.style.getPropertyValue("--row-h")).toBe("27px");
  expect(root.style.getPropertyValue("--grid-font")).toContain("Menlo");
});

test("index.html resolves «as in the OS» and works without a cache", () => {
  const mm = vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) => ({ matches: q.includes("dark"), media: q }) as unknown as MediaQueryList,
  );
  localStorage.setItem("carbus:theme", JSON.stringify({ theme: "system" }));
  bootScript()();
  expect(root.dataset.theme).toBe("dark");
  localStorage.clear();
  mm.mockImplementation((q: string) => ({ matches: false, media: q }) as unknown as MediaQueryList);
  bootScript()();
  expect(root.dataset.theme).toBe("light");
});

test("until the server sends its settings the app keeps the remembered theme, then follows the server", async () => {
  localStorage.setItem("carbus:theme", JSON.stringify({ theme: "dark", grid_font_size: 15 }));
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) => ({ matches: false, media: q, addEventListener: () => {} }) as unknown as MediaQueryList,
  );
  await import("../src/app/App"); // ставит эффект темы
  const { rowHeight } = await import("../src/ui/grid/VirtualGrid");
  expect(root.dataset.theme).toBe("dark"); // не «как в ОС» (светлая) из настроек по умолчанию
  expect(rowHeight.value).toBe(Math.round(15 * 1.7));
  const { applyEvent } = await import("../src/core/store");
  applyEvent({ type: "hello", status: { type: "status", state: "closed", message: "", device_info: null, channels: {} },
    settings: { ...DEFAULT_SETTINGS, theme: "light", grid_font_size: 13 }, comments: {}, connection: null,
    capture: { type: "capture_state", recording: false, count: 0, duration_s: 0, full: false, rev: 0, markers: [] },
    tx: { tasks: [] }, filters: { type: "filters", hw: [], hw_layout: {}, ranges: [] },
    tracer: { type: "tracer_state" } });
  expect(root.dataset.theme).toBe("light");
  expect(cachedTheme()).toMatchObject({ theme: "light", grid_font_size: 13 });
});
