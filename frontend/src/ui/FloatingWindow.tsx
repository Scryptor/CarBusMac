/** Плавающее окно внутри страницы (битовая карта, «Данные сообщения»): тянется за
 * заголовок, остаётся в пределах экрана, помнит позицию, по клику выходит наверх. */
import { X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n/ru";
import { clampToViewport } from "./Menu";

let zTop = 500;

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
  initial: { x: number; y: number };
  onClose: () => void;
  headExtra?: ComponentChildren;
  children: ComponentChildren;
}

export function FloatingWindow({ id, title, width, height, initial, onClose, headExtra, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => loadPos(id) ?? initial);
  const [z, setZ] = useState(() => ++zTop);
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
      class="float"
      role="dialog"
      aria-label={title}
      style={{ left: `${pos.x}px`, top: `${pos.y}px`, width: `${width}px`, height: height ? `${height}px` : undefined, zIndex: z }}
      onMouseDown={() => setZ(++zTop)}
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
