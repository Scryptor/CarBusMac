/** Применение настроек оформления: тема (с «как в ОС»), шрифт таблиц, цвет и время
 * подсветки изменившихся байтов — через атрибут data-theme и CSS-переменные.
 * Оформление с сервера запоминается в браузере: index.html применяет его до загрузки
 * приложения, а до ответа сервера приложение держит его же — без вспышки темы. */
import type { Settings } from "./types";
import { gridScale, rowHeight } from "../ui/grid/VirtualGrid";

/** Ключ кэша оформления — его же читает встроенный скрипт в index.html. */
const CACHE_KEY = "carbus:theme";

export function rememberTheme(s: Settings): void {
  try {
    const { theme, grid_font, grid_font_size, mark_color, mark_hold_ms } = s;
    localStorage.setItem(CACHE_KEY, JSON.stringify({ theme, grid_font, grid_font_size, mark_color, mark_hold_ms }));
  } catch {
    /* без localStorage тема просто применится после ответа сервера */
  }
}

/** Запомненное оформление; мусор в кэше отбрасывается по полям. */
export function cachedTheme(): Partial<Settings> {
  let v: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    if (parsed && typeof parsed === "object") v = parsed as Record<string, unknown>;
  } catch {
    /* нет localStorage или битый JSON */
  }
  const out: Partial<Settings> = {};
  if (!v) return out;
  if (v.theme === "light" || v.theme === "dark" || v.theme === "system") out.theme = v.theme;
  if (typeof v.grid_font === "string" && v.grid_font) out.grid_font = v.grid_font;
  if (typeof v.grid_font_size === "number" && v.grid_font_size >= 6 && v.grid_font_size <= 48) out.grid_font_size = v.grid_font_size;
  if (typeof v.mark_color === "string" && v.mark_color) out.mark_color = v.mark_color;
  if (typeof v.mark_hold_ms === "number" && v.mark_hold_ms >= 0) out.mark_hold_ms = v.mark_hold_ms;
  return out;
}

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
  // формулы шрифта и высоты строки повторяет встроенный скрипт index.html — менять вместе
  root.style.setProperty("--grid-font", `"${s.grid_font}", "SF Mono", Menlo, Monaco, monospace`);
  root.style.setProperty("--grid-size", `${s.grid_font_size}px`);
  // высоту строки не читаем из сигнала: иначе эффект, вызывающий applyTheme, подписался бы
  // на неё и откатывал предпросмотр шрифта в настройках
  const rh = Math.round(s.grid_font_size * 1.7);
  rowHeight.value = rh;
  gridScale.value = s.grid_font_size / 13;
  root.style.setProperty("--row-h", `${rh}px`);
  root.style.setProperty("--mark", s.mark_color);
  root.style.setProperty("--hold", `${s.mark_hold_ms}ms`);
}
