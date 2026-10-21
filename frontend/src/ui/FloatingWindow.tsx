/** Плавающее окно внутри страницы (битовая карта, «Данные сообщения»): тянется за
 * заголовок, остаётся в пределах экрана, помнит позицию, по клику выходит наверх. */
import { signal } from "@preact/signals";
import { X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n/ru";
import { clampToViewport } from "./Menu";

/** Порядок плавающих окон снизу вверх; z-index = 500 + место в нём — окна всегда под
 * модальной подложкой (900) и меню (1000), сколько по ним ни щёлкай. */
const order = signal<object[]>([]);
const Z_BASE = 500;

function raise(win: object): void {
  const cur = order.value;
  if (cur[cur.length - 1] === win) return; // уже сверху
  order.value = [...cur.filter((w) => w !== win), win];
}

function loadPos(id: string): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(`float:${id}`);
    return raw ? (JSON.parse(raw) as { x: number; y: number }) : null;
  } catch {
    return null;
  }
}

function savePos(id: string, p: { x: number; y: number }): void {
  try {
    localStorage.setItem(`float:${id}`, JSON.stringify(p));
  } catch {
    /* приватный режим — позиция не запомнится */
  }
}

interface Props {
  id: string;
  title: string;
  width: number;
  height?: number;
  /** окно тянется за правый нижний угол (таблицы) */
  resizable?: boolean;
  initial: { x: number; y: number };
  onClose: () => void;
  headExtra?: ComponentChildren;
  children: ComponentChildren;
}

export function FloatingWindow({ id, title, width, height, resizable, initial, onClose, headExtra, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => loadPos(id) ?? initial);
  const self = useRef({}).current;
  const z = Z_BASE + Math.max(0, order.value.indexOf(self));
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const clamp = (p: { x: number; y: number }) => {
    const r = ref.current?.getBoundingClientRect();
    return clampToViewport(p.x, p.y, r?.width ?? width, r?.height ?? height ?? 200, 0);
  };

  useEffect(() => {
    setPos((p) => clamp(p));
    const onResize = () => setPos((p) => clamp(p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // новое окно — сверху; закрытое уходит из порядка
  useEffect(() => {
    raise(self);
    return () => {
      order.value = order.value.filter((w) => w !== self);
    };
  }, []);

  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag.current) return;
    setPos(clamp({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }));
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    savePos(id, pos);
  };

  return (
    <div
      ref={ref}
      class={resizable ? "float resizable" : "float"}
      role="dialog"
      aria-label={title}
      style={{ left: `${pos.x}px`, top: `${pos.y}px`, width: `${width}px`, height: height ? `${height}px` : undefined, zIndex: z }}
      onMouseDown={() => raise(self)}
    >
      <div class="float-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        <span class="title">{title}</span>
        {headExtra}
        <button type="button" class="icon-btn" aria-label={t.common.close} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div class="float-body">{children}</div>
    </div>
  );
}
