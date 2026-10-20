/** Разделитель панелей: сообщает смещение от начала перетаскивания; итоговый размер
 * считает и запоминает владелец панели. */
import { useRef, useState } from "preact/hooks";

interface Props {
  dir: "row" | "col"; // row — вертикальная полоса между колонками, col — горизонтальная между рядами
  onStart: () => void;
  onDrag: (delta: number) => void;
  onEnd?: () => void;
}

export function Splitter({ dir, onStart, onDrag, onEnd }: Props) {
  const start = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      class={`splitter ${dir}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation={dir === "row" ? "vertical" : "horizontal"}
      onPointerDown={(e) => {
        start.current = dir === "row" ? e.clientX : e.clientY;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDragging(true);
        onStart();
      }}
      onPointerMove={(e) => {
        if (start.current == null) return;
        onDrag((dir === "row" ? e.clientX : e.clientY) - start.current);
      }}
      onPointerUp={() => {
        start.current = null;
        setDragging(false);
        onEnd?.();
      }}
    />
  );
}
