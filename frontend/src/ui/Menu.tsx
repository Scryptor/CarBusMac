/** Модель пунктов меню и список пунктов, общий для строки меню, выпадающих кнопок и
 * контекстных меню. Пункт ссылается на действие реестра или задаётся прямо. */
import { Check, ChevronRight } from "lucide-preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { actionsVersion, getAction, isEnabled, shortcutLabel } from "../core/actions";

export type MenuItem =
  | { separator: true }
  | { action: string; label?: string }
  | { label: string; items: MenuItem[]; disabled?: boolean }
  | { label: string; run: () => void; disabled?: boolean; checked?: boolean; shortcut?: string };

type Resolved =
  | { kind: "sep" }
  | { kind: "item"; label: string; shortcut?: string; checked?: boolean; disabled: boolean; run: () => void }
  | { kind: "sub"; label: string; items: MenuItem[]; disabled: boolean };

export function resolveItem(item: MenuItem): Resolved | null {
  if ("separator" in item) return { kind: "sep" };
  if ("action" in item) {
    const a = getAction(item.action);
    if (!a) return null;
    return {
      kind: "item",
      label: item.label ?? a.label,
      shortcut: a.shortcut,
      checked: a.checked?.(),
      disabled: !isEnabled(a),
      run: () => void a.run(),
    };
  }
  if ("items" in item) return { kind: "sub", label: item.label, items: item.items, disabled: Boolean(item.disabled) };
  return {
    kind: "item",
    label: item.label,
    shortcut: item.shortcut,
    checked: item.checked,
    disabled: Boolean(item.disabled),
    run: item.run,
  };
}

/** Пункты без пустых (незарегистрированных действий) и без «сиротских» разделителей:
 * по краям меню и подряд разделитель не рисуется. */
export function compactItems(items: MenuItem[]): Resolved[] {
  const out: Resolved[] = [];
  for (const it of items) {
    const r = resolveItem(it);
    if (!r) continue;
    if (r.kind === "sep" && (out.length === 0 || out[out.length - 1].kind === "sep")) continue;
    out.push(r);
  }
  while (out.length && out[out.length - 1].kind === "sep") out.pop();
  return out;
}

export function hasVisibleItems(items: MenuItem[]): boolean {
  return compactItems(items).length > 0;
}

/** Позиция всплывающего блока, прижатая к краям окна (ничего не уходит за экран). */
export function clampToViewport(x: number, y: number, w: number, h: number, margin = 4): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(margin, Math.min(x, vw - w - margin)),
    y: Math.max(margin, Math.min(y, vh - h - margin)),
  };
}

interface PopupProps {
  x: number;
  y: number;
  items: MenuItem[];
  onDone: () => void;
  depth?: number;
}

export function PopupMenu({ x, y, items, onDone, depth = 0 }: PopupProps) {
  actionsVersion.value; // перерисовка при смене реестра
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);
  const resolved = compactItems(items);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(clampToViewport(x, y, r.width, r.height));
    if (depth === 0) el.focus();
  }, [x, y, items.length]);

  const select = (i: number, el?: HTMLElement) => {
    const r = resolved[i];
    if (!r || r.kind === "sep" || r.disabled) return;
    if (r.kind === "sub") {
      const rect = el?.getBoundingClientRect();
      if (rect) setSub({ index: i, x: rect.right - 2, y: rect.top - 4 });
      return;
    }
    onDone();
    r.run();
  };

  const move = (dir: 1 | -1) => {
    for (let k = 1; k <= resolved.length; k++) {
      const i = (active + dir * k + resolved.length) % resolved.length;
      const r = resolved[i];
      if (r && r.kind !== "sep" && !r.disabled) {
        setActive(i);
        return;
      }
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
      const el = ref.current?.querySelectorAll<HTMLElement>("[data-i]")[active];
      if (active >= 0) select(active, el);
    } else if (e.key === "Escape" || (e.key === "ArrowLeft" && depth > 0)) onDone();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const subItems = sub ? (resolved[sub.index] as Extract<Resolved, { kind: "sub" }>).items : null;

  return (
    <>
      <div
        ref={ref}
        class="popup"
        role="menu"
        tabIndex={-1}
        style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
        onKeyDown={onKey}
      >
        {resolved.map((r, i) => {
          if (!r) return null;
          if (r.kind === "sep") return <div class="ctx-sep" role="separator" />;
          return (
            <div
              data-i={i}
              role="menuitem"
              aria-disabled={r.disabled ? "true" : undefined}
              class={"menu-item" + (i === active ? " active" : "")}
              onMouseEnter={(e) => {
                setActive(i);
                if (r.kind === "sub" && !r.disabled) select(i, e.currentTarget as HTMLElement);
                else setSub(null);
              }}
              onClick={(e) => select(i, e.currentTarget as HTMLElement)}
            >
              <span>{r.kind === "item" && r.checked ? <Check size={14} /> : null}</span>
              <span>{r.label}</span>
              <span class="sc">
                {r.kind === "item" && r.shortcut ? shortcutLabel(r.shortcut) : null}
                {r.kind === "sub" ? <ChevronRight size={14} /> : null}
              </span>
            </div>
          );
        })}
      </div>
      {sub && subItems ? <PopupMenu x={sub.x} y={sub.y} items={subItems} onDone={onDone} depth={depth + 1} /> : null}
    </>
  );
}
