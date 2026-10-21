/** Единый реестр действий (аналог TActionList десктопа): из одних и тех же действий
 * строятся главное меню, тулбары, контекстные меню и хоткеи — подпись, хоткей,
 * доступность и отметка у пункта меню и у кнопки всегда совпадают. */
import { signal } from "@preact/signals";
import type { ComponentType } from "preact";

export type View = "main" | "tracer";
export type Scope = View | "global";

export interface Action {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  icon?: ComponentType<{ size?: number | string; strokeWidth?: number | string }>;
  scope?: Scope;
  enabled?: () => boolean;
  checked?: () => boolean;
  run: () => unknown;
}

const registry = new Map<string, Action>();
/** Меняется при (раз)регистрации — компоненты меню подписываются, чтобы перерисоваться. */
export const actionsVersion = signal(0);

export function registerActions(list: Action[]): () => void {
  for (const a of list) registry.set(a.id, a);
  actionsVersion.value++;
  return () => {
    for (const a of list) if (registry.get(a.id) === a) registry.delete(a.id);
    actionsVersion.value++;
  };
}

export function clearActions(): void {
  registry.clear();
  actionsVersion.value++;
}

export function getAction(id: string): Action | undefined {
  return registry.get(id);
}

export function isEnabled(a: Action): boolean {
  return a.enabled ? a.enabled() : true;
}

export function runAction(id: string): boolean {
  const a = registry.get(id);
  if (!a || !isEnabled(a)) return false;
  void a.run();
  return true;
}

export function findByShortcut(key: string, view: View): Action | undefined {
  let global: Action | undefined;
  for (const a of registry.values()) {
    if (a.shortcut !== key) continue;
    const scope = a.scope ?? "global";
    if (scope === view) return a;
    if (scope === "global") global = a;
  }
  return global;
}

/** «Подсказка (F3)» для title кнопок. */
export function hintText(a: Action): string {
  const base = a.hint ?? a.label;
  // подсказки десктопа иногда уже несут хоткей: «…метку (F8 / Автоматическая метка - F9)»
  return a.shortcut && !base.includes(shortcutLabel(a.shortcut)) ? `${base} (${shortcutLabel(a.shortcut)})` : base;
}

/** Хоткей для показа человеку: «Ctrl+ArrowDown» → «Ctrl+↓». */
export function shortcutLabel(s: string): string {
  return s
    .replace("ArrowDown", "↓")
    .replace("ArrowUp", "↑")
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace("Insert", "Ins")
    .replace("Delete", "Del");
}
