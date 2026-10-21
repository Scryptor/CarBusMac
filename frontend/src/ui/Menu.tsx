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
  /** подменю: закрыть только его (ArrowLeft) */
  onBack?: () => void;
  /** открыто с клавиатуры: взять фокус и выделить первый пункт */
  keyboard?: boolean;
}

export function PopupMenu({ x, y, items, onDone, depth = 0, onBack, keyboard }: PopupProps) {
  actionsVersion.value; // перерисовка при смене реестра
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; x: number; y: number; keyboard: boolean } | null>(null);
  const resolved = compactItems(items);
  const usable = (r: Resolved | undefined) => Boolean(r && r.kind !== "sep" && !r.disabled);

  // корневое меню возвращает фокус туда, где он был до открытия (Escape, выбор пункта),
  // если фокус оставался в меню, — как меню настольных программ
  useLayoutEffect(() => {
    if (depth > 0) return;
    const prev = document.activeElement;
    return () => {
      const a = document.activeElement;
      const inMenu = a == null || a === document.body || Boolean(a.closest(".popup"));
      if (inMenu && prev instanceof HTMLElement && prev !== document.body && prev.isConnected) prev.focus();
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(clampToViewport(x, y, r.width, r.height));
    if (depth === 0 || keyboard) el.focus();
    if (keyboard && active < 0) setActive(resolved.findIndex(usable));
  }, [x, y, items.length, keyboard]);

  const select = (i: number, el?: HTMLElement | null, fromKeyboard = false) => {
    const r = resolved[i];
    if (!r || r.kind === "sep" || r.disabled) return;
    if (r.kind === "sub") {
      const rect = el?.getBoundingClientRect();
      if (rect) setSub({ index: i, x: rect.right - 2, y: rect.top - 4, keyboard: fromKeyboard });
      return;
    }
    onDone();
    r.run();
  };

  const move = (dir: 1 | -1) => {
    for (let k = 1; k <= resolved.length; k++) {
      const i = (active + dir * k + resolved.length) % resolved.length;
      if (usable(resolved[i])) {
        setActive(i);
        if (sub && sub.index !== i) setSub(null); // подменю, открытое наведением, — закрыть
        return;
      }
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter" || e.key === " " || (e.key === "ArrowRight" && resolved[active]?.kind === "sub")) {
      // пункт ищем по data-i: у разделителей его нет, индекс в списке узлов не совпадает
      if (active >= 0) select(active, ref.current?.querySelector<HTMLElement>(`[data-i="${active}"]`), true);
    } else if (e.key === "ArrowLeft" && depth > 0) (onBack ?? onDone)();
    else if (e.key === "Escape") onDone();
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
              // пункт с галочкой (режим вкл/выкл) — для экранного диктора menuitemcheckbox
              role={r.kind === "item" && r.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={r.kind === "item" && r.checked !== undefined ? r.checked : undefined}
              aria-disabled={r.disabled ? "true" : undefined}
              class={"menu-item" + (i === active ? " active" : "")}
              onMouseEnter={(e) => {
                setActive(i);
                if (r.kind === "sub" && !r.disabled) select(i, e.currentTarget as HTMLElement);
                else if (sub) {
                  setSub(null);
                  // фокус был в подменю (открыто с клавиатуры) — вернуть его этому меню
                  if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
                }
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
      {sub && subItems ? (
        <PopupMenu
          key={sub.index}
          x={sub.x}
          y={sub.y}
          items={subItems}
          onDone={onDone}
          depth={depth + 1}
          keyboard={sub.keyboard}
          onBack={() => {
            setSub(null);
            ref.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
