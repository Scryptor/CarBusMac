/** Кнопки тулбара из реестра действий: иконка, подсказка «Текст (хоткей)», нажатое
 * состояние для переключателей, сплит-кнопка с выпадающим меню. */
import { ChevronDown } from "lucide-preact";
import type { ComponentType } from "preact";
import { actionsVersion, getAction, hintText, isEnabled, runAction } from "../core/actions";
import { openMenuBelow } from "./ContextMenu";
import type { MenuItem } from "./Menu";
import { t } from "../i18n/ru";

interface BtnProps {
  action: string;
  showLabel?: boolean;
  label?: string;
  class?: string;
}

export function ToolButton({ action, showLabel, label, class: cls }: BtnProps) {
  actionsVersion.value;
  const a = getAction(action);
  if (!a) return null;
  const Icon = a.icon;
  const checked = a.checked?.();
  return (
    <button
      type="button"
      class={"toolbtn" + (cls ? ` ${cls}` : "")}
      title={hintText(a)}
      aria-label={a.label}
      aria-pressed={checked === undefined ? undefined : checked}
      disabled={!isEnabled(a)}
      onClick={() => runAction(action)}
    >
      {Icon ? <Icon size={18} strokeWidth={1.75} /> : null}
      {showLabel ? <span>{label ?? a.label}</span> : null}
    </button>
  );
}

export function ToolSplit({ action, items, showLabel }: { action: string; items: () => MenuItem[]; showLabel?: boolean }) {
  const a = getAction(action);
  return (
    <span class="tool-split">
      <ToolButton action={action} showLabel={showLabel} />
      <button
        type="button"
        class="toolbtn arrow"
        aria-label={t.ui.menuOf(a?.label ?? "")}
        data-menu-owner={`split:${action}`}
        onMouseDown={(e) => {
          e.preventDefault();
          openMenuBelow(e.currentTarget as HTMLElement, items(), `split:${action}`);
        }}
      >
        <ChevronDown size={14} />
      </button>
    </span>
  );
}

/** Кнопка с выпадающим меню (без собственного действия): иконка, подпись текущего
 * значения и стрелка — «Пауза между сообщениями», «Точка назначения». */
export function ToolMenu({ id, icon: Icon, label, title, items }: {
  id: string;
  icon?: ComponentType<{ size?: number | string; strokeWidth?: number | string }>;
  label?: string;
  title: string;
  items: () => MenuItem[];
}) {
  const owner = `menu:${id}`;
  const open = (el: HTMLElement) => openMenuBelow(el, items(), owner);
  return (
    <button
      type="button"
      class="toolbtn menu"
      title={title}
      aria-label={label ? `${title}: ${label}` : title}
      aria-haspopup="menu"
      data-menu-owner={owner}
      onMouseDown={(e) => {
        e.preventDefault();
        open(e.currentTarget as HTMLElement);
      }}
      onClick={(e) => {
        if (e.detail === 0) open(e.currentTarget as HTMLElement); // Enter/пробел с клавиатуры
      }}
    >
      {Icon ? <Icon size={18} strokeWidth={1.75} /> : null}
      {label ? <span>{label}</span> : null}
      <ChevronDown size={14} />
    </button>
  );
}

export const ToolSep = () => <span class="tool-sep" aria-hidden="true" />;
