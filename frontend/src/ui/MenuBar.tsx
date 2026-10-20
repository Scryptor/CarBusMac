/** Строка главного меню (Файл · Подключиться · …): клик открывает меню, при открытом
 * меню наведение на соседний пункт переключает его — как в настольных программах. */
import type { MenuItem } from "./Menu";
import { openMenuBelow, popup } from "./ContextMenu";

export interface TopMenu {
  label: string;
  items: MenuItem[];
}

export function MenuBar({ menus, right }: { menus: TopMenu[]; right?: preact.ComponentChildren }) {
  const openOwner = popup.value?.owner;
  const open = (m: TopMenu, el: HTMLElement) => openMenuBelow(el, m.items, `menubar:${m.label}`);
  return (
    <div class="menubar" role="menubar">
      {menus.map((m) => {
        const owner = `menubar:${m.label}`;
        const isOpen = openOwner === owner;
        return (
          <button
            type="button"
            class={"menubar-item" + (isOpen ? " open" : "")}
            data-menu-owner={owner}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            onMouseDown={(e) => {
              e.preventDefault();
              if (isOpen) popup.value = null;
              else open(m, e.currentTarget as HTMLElement);
            }}
            onMouseEnter={(e) => {
              if (openOwner?.startsWith("menubar:") && !isOpen) open(m, e.currentTarget as HTMLElement);
            }}
          >
            {m.label}
          </button>
        );
      })}
      <span class="tool-spacer" />
      {right}
    </div>
  );
}
