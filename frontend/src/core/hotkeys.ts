/** Глобальные хоткеи десктопа (F2, F3, Ctrl+N, …). Сочетания с Cmd оставляем браузеру,
 * в полях ввода срабатывают только F-клавиши — Ctrl+буква на маке там двигает курсор. */
import { findByShortcut, isEnabled, type View } from "./actions";

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "CapsLock"]);

export function normalizeKey(e: KeyLike): string {
  if (e.metaKey || MODIFIER_KEYS.has(e.key)) return "";
  let key = e.key;
  if (key.length === 1) key = key.toUpperCase();
  const mods = [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt"].filter(Boolean);
  return [...mods, key].join("+");
}

const isFKey = (key: string) => /(^|\+)F\d{1,2}$/.test(key);

function isEditable(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(el.isContentEditable);
}

export function shouldHandle(key: string, target: EventTarget | null): boolean {
  if (!key) return false;
  if (isEditable(target)) return isFKey(key);
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
