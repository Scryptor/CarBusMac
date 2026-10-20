/** Состояние раскладки окна (вид, режим приёма, видимость и размеры панелей) — в
 * localStorage браузера; плюс хост модальных диалогов и плавающих окон. */
import { signal, effect, type Signal } from "@preact/signals";
import type { VNode } from "preact";
import { closeContextMenu } from "../ui/ContextMenu";

function persisted<T>(key: string, initial: T): Signal<T> {
  let start = initial;
  try {
    const raw = localStorage.getItem(`ui:${key}`);
    if (raw != null) start = JSON.parse(raw) as T;
  } catch {
    /* без localStorage — значения по умолчанию */
  }
  const s = signal<T>(start);
  effect(() => {
    try {
      localStorage.setItem(`ui:${key}`, JSON.stringify(s.value));
    } catch {
      /* ignore */
    }
  });
  return s;
}

export const ui = {
  view: signal<"main" | "tracer">("main"),
  receiveMode: persisted<"monitor" | "stream">("receiveMode", "monitor"),
  split: persisted<boolean>("split", false),
  dockOpen: persisted<boolean>("dockOpen", true),
  dockHeight: persisted<number>("dockHeight", 270),
  filtersOpen: persisted<boolean>("filtersOpen", false),
  filtersWidth: persisted<number>("filtersWidth", 340),
  tracerIdsOpen: persisted<boolean>("tracerIdsOpen", true),
  tracerIdsWidth: persisted<number>("tracerIdsWidth", 270),
  /** «Разрешить передавать выделенные фреймы» */
  tracerPlaySelected: persisted<boolean>("tracerPlaySelected", false),
  /** «Недавно открытые» трейсы — список имён, свежие сверху */
  tracerRecent: persisted<string[]>("tracerRecent", []),
};

// меню всегда относится к виду, где его открыли: при смене вида (F12, F2) закрываем
let lastView = ui.view.value;
effect(() => {
  const v = ui.view.value;
  if (v !== lastView) closeContextMenu();
  lastView = v;
});

/** Один модальный диалог за раз (как в десктопе). */
export const dialog = signal<VNode | null>(null);

export function openDialog(v: VNode): void {
  dialog.value = v;
}

export function closeDialog(): void {
  dialog.value = null;
}

/** Плавающие окна по ключу (битовые карты, «Данные сообщения»). */
export const floats = signal<Map<string, VNode>>(new Map());

export function openFloat(key: string, v: VNode): void {
  const next = new Map(floats.value);
  next.set(key, v);
  floats.value = next;
}

export function closeFloat(key: string): void {
  const next = new Map(floats.value);
  next.delete(key);
  floats.value = next;
}
