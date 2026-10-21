/** Единственный слой всплывающих меню: контекстные меню, выпадающие кнопки тулбара и
 * пункты строки меню. Закрывается кликом мимо, Escape, прокруткой и потерей фокуса окна. */
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { isOwnScroll } from "./grid/VirtualGrid";
import { PopupMenu, type MenuItem } from "./Menu";

const inMenu = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(".popup"));

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
    // прокрутка любого элемента (scroll не всплывает — ловим в фазе перехвата), кроме самого
    // меню и прокрутки, которую грид выставил сам: автоследование идущей записи и переход
    // к строке закрывали бы меню сразу после открытия
    const onScroll = (e: Event) => {
      const target = e.target;
      if (inMenu(target) || (target instanceof Element && isOwnScroll(target))) return;
      closeContextMenu();
    };
    const onWheel = (e: WheelEvent) => {
      if (!inMenu(e.target)) closeContextMenu();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
      document.removeEventListener("keydown", onKey);
    };
  }, [p]);
  if (!p) return null;
  return <PopupMenu x={p.x} y={p.y} items={p.items} onDone={closeContextMenu} />;
}
