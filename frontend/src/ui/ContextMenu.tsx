/** Единственный слой всплывающих меню: контекстные меню, выпадающие кнопки тулбара и
 * пункты строки меню. Закрывается кликом мимо, Escape, прокруткой и потерей фокуса окна. */
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { PopupMenu, type MenuItem } from "./Menu";

interface PopupState {
  x: number;
  y: number;
  items: MenuItem[];
  owner?: string;
}

export const popup = signal<PopupState | null>(null);

export function openContextMenu(x: number, y: number, items: MenuItem[], owner?: string): void {
  popup.value = { x, y, items, owner };
}

/** Меню под элементом (кнопка тулбара, пункт строки меню). */
export function openMenuBelow(el: HTMLElement, items: MenuItem[], owner?: string): void {
  const r = el.getBoundingClientRect();
  openContextMenu(r.left, r.bottom + 2, items, owner);
}

export function closeContextMenu(): void {
  popup.value = null;
}

export function ContextMenuLayer() {
  const p = popup.value;
  useEffect(() => {
    if (!p) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".popup")) return;
      if (p.owner && t?.closest(`[data-menu-owner="${p.owner}"]`)) return;
      closeContextMenu();
    };
    const onBlur = () => closeContextMenu();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeContextMenu();
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
      document.removeEventListener("keydown", onKey);
    };
  }, [p]);
  if (!p) return null;
  return <PopupMenu x={p.x} y={p.y} items={p.items} onDone={closeContextMenu} />;
}
