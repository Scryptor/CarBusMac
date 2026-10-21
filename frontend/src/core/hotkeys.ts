/** Глобальные хоткеи десктопа (F2, F3, Ctrl+N, …). Сочетания с Cmd оставляем браузеру,
 * в текстовых полях срабатывают только F-клавиши — Ctrl+буква на маке там двигает курсор.
 * Буква сочетания не зависит от раскладки: в русской Ctrl+F приходит как key «а». */
import { findByShortcut, isEnabled, type View } from "./actions";

export interface KeyLike {
  key: string;
  /** физическая клавиша (KeyF, Digit1, …); у синтетических событий может не быть */
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "CapsLock"]);

export function normalizeKey(e: KeyLike): string {
  if (e.metaKey || MODIFIER_KEYS.has(e.key)) return "";
  let key = e.key;
  // не латинская буква/цифра (русская раскладка, символ с Shift/Option) — берём букву или
  // цифру физической клавиши; латинскую букву оставляем как есть (AZERTY, Dvorak)
  const phys = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code ?? "");
  if (phys && !/^[A-Za-z0-9]$/.test(key)) key = phys[1] ?? phys[2];
  if (key.length === 1) key = key.toUpperCase();
  const mods = [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt"].filter(Boolean);
  return [...mods, key].join("+");
}

const isFKey = (key: string) => /(^|\+)F\d{1,2}$/.test(key);

/** Не текстовые поля ввода: в фокусе у них сочетания окна должны работать. */
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "color", "range", "image", "hidden"]);

/** Клавиши, которые выпадающий список обрабатывает сам: стрелки, листание, открытие и
 * поиск по первой букве. Ctrl-сочетания, F-клавиши, Ins списку не нужны. */
const SELECT_OWN_KEY = /^(Shift\+)?(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Enter|Escape|Tab|.)$/;

function editKind(target: EventTarget | null): "text" | "select" | null {
  const el = target as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (!el) return null;
  if (el.isContentEditable) return "text";
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return "text";
  if (tag === "SELECT") return "select";
  if (tag === "INPUT") return NON_TEXT_INPUTS.has((el.type ?? "text").toLowerCase()) ? null : "text";
  return null;
}

export function shouldHandle(key: string, target: EventTarget | null): boolean {
  if (!key) return false;
  if (isFKey(key)) return true;
  const kind = editKind(target);
  if (kind === "text") return false;
  if (kind === "select") return !SELECT_OWN_KEY.test(key);
  return true;
}

/** Ставит обработчик keydown на window; возвращает функцию снятия. */
export function installHotkeys(getView: () => View, blocked: () => boolean = () => false): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (blocked()) return;           // открыт модальный диалог — хоткеи окна не работают
    const key = normalizeKey(e);
    if (!shouldHandle(key, e.target)) return;
    const action = findByShortcut(key, getView());
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (isEnabled(action)) void action.run();
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
