/** Строка главного меню (Файл · Подключиться · …): клик открывает меню, при открытом
 * меню наведение на соседний пункт переключает его — как в настольных программах.
 * Пункт верхнего уровня может быть и прямым действием («Подключиться», «Отладчик»). */
import type { ComponentChildren } from "preact";
import { actionsVersion, getAction, isEnabled, runAction } from "../core/actions";
import { hasVisibleItems, type MenuItem } from "./Menu";
import { closeContextMenu, openMenuBelow, popup } from "./ContextMenu";

export type TopMenu = { label: string; items: MenuItem[] } | { label: string; action: string };

export function MenuBar({ menus, right }: { menus: TopMenu[]; right?: ComponentChildren }) {
  actionsVersion.value;
  const openOwner = popup.value?.owner;
  return (
    <div class="menubar" role="menubar">
      {menus.map((m) => {
        const owner = `menubar:${m.label}`;
        if ("action" in m) {
          const a = getAction(m.action);
          return (
            <button
              type="button"
              class="menubar-item"
              role="menuitem"
              disabled={!a || !isEnabled(a)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                closeContextMenu();
                runAction(m.action);
              }}
            >
              {m.label}
            </button>
          );
        }
        const isOpen = openOwner === owner;
        return (
          <button
            type="button"
            class={"menubar-item" + (isOpen ? " open" : "")}
            data-menu-owner={owner}
            disabled={!hasVisibleItems(m.items)}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            onMouseDown={(e) => {
              e.preventDefault();
              if (isOpen) popup.value = null;
              else openMenuBelow(e.currentTarget as HTMLElement, m.items, owner);
            }}
            onClick={(e) => {
              // Enter/пробел с клавиатуры (мышь открывает по mousedown)
              if (e.detail !== 0) return;
              if (isOpen) popup.value = null;
              else openMenuBelow(e.currentTarget as HTMLElement, m.items, owner);
            }}
            onMouseEnter={(e) => {
              if (openOwner?.startsWith("menubar:") && !isOpen) openMenuBelow(e.currentTarget as HTMLElement, m.items, owner);
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
