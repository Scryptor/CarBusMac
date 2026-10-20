/** Применение настроек оформления: тема (с «как в ОС»), шрифт таблиц, цвет и время
 * подсветки изменившихся байтов — через атрибут data-theme и CSS-переменные. */
import type { Settings } from "./types";
import { rowHeight } from "../ui/grid/VirtualGrid";

let mq: MediaQueryList | null = null;
let current: Settings | null = null;

function resolve(theme: Settings["theme"]): "light" | "dark" {
  if (theme !== "system") return theme;
  return mq?.matches ? "dark" : "light";
}

export function applyTheme(s: Settings): void {
  current = s;
  if (!mq && typeof window !== "undefined" && window.matchMedia) {
    mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", () => current && applyTheme(current));
  }
  const root = document.documentElement;
  root.dataset.theme = resolve(s.theme);
  root.style.setProperty("--grid-font", `"${s.grid_font}", "SF Mono", Menlo, Monaco, monospace`);
  root.style.setProperty("--grid-size", `${s.grid_font_size}px`);
  rowHeight.value = Math.round(s.grid_font_size * 1.7);
  root.style.setProperty("--row-h", `${rowHeight.value}px`);
  root.style.setProperty("--mark", s.mark_color);
  root.style.setProperty("--hold", `${s.mark_hold_ms}ms`);
}
