/** Кнопки тулбара из реестра действий: иконка, подсказка «Текст (хоткей)», нажатое
 * состояние для переключателей, сплит-кнопка с выпадающим меню. */
import { ChevronDown } from "lucide-preact";
import { actionsVersion, getAction, hintText, isEnabled, runAction } from "../core/actions";
import { openMenuBelow } from "./ContextMenu";
import type { MenuItem } from "./Menu";

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
        aria-label={`${a?.label ?? ""}: меню`}
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

export const ToolSep = () => <span class="tool-sep" aria-hidden="true" />;
