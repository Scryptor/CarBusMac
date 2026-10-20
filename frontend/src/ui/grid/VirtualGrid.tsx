/** Виртуальный грид (аналог TDrawGrid десктопа): рисует только видимые строки,
 * шапка закреплена, ширины колонок тянутся и запоминаются, выделение мышью и
 * клавиатурой, контекстное меню, автоследование за концом (поток, отладчик). */
import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { isAtBottom, scrollTopForRow, visibleRange } from "./gridMath";
import type { Selection } from "./selection";

/** Высота строки в px (из настроек шрифта таблиц, ставится applyTheme). */
export const rowHeight = signal(22);
/** Масштаб ширин колонок по шрифту таблиц (13 px = 1): крупный шрифт не обрезает данные.
 * Ширины, заданные перетаскиванием, хранятся в тех же базовых единицах. */
export const gridScale = signal(1);

export interface Column<R> {
  key: string;
  title: string;
  width: number;
  minWidth?: number;
  /** забирает свободную ширину таблицы (обычно «Комментарий») */
  fill?: boolean;
  align?: "left" | "right" | "center";
  render: (row: R, i: number) => ComponentChildren;
  title_hint?: string;
}

export interface GridController {
  scrollToRow(i: number): void;
  focus(): void;
}

interface Props<R> {
  gridId: string;
  ariaLabel: string;
  columns: Column<R>[];
  rowCount: number;
  getRow: (i: number) => R | undefined;
  version?: number;
  rowClass?: (row: R, i: number) => string | undefined;
  selection?: Selection;
  multi?: boolean;
  onSelectionChange?: () => void;
  onActivate?: (i: number) => void;
  onContextMenu?: (e: MouseEvent, i: number | null) => void;
  onRange?: (first: number, last: number) => void;
  onKey?: (e: KeyboardEvent) => boolean;
  follow?: boolean;
  emptyText?: ComponentChildren;
  controller?: (c: GridController) => void;
}

const HEAD_H = 26;

function loadWidths(gridId: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(`grid:${gridId}:w`) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function saveWidths(gridId: string, w: Record<string, number>): void {
  try {
    localStorage.setItem(`grid:${gridId}:w`, JSON.stringify(w));
  } catch {
    /* без localStorage ширины просто не запомнятся */
  }
}

export function VirtualGrid<R>(props: Props<R>) {
  const { gridId, columns, rowCount, getRow, selection, multi } = props;
  const rowH = rowHeight.value;
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);
  const [viewportW, setViewportW] = useState(0);
  const [widths, setWidths] = useState<Record<string, number>>(() => loadWidths(gridId));
  const [, setTick] = useState(0);
  const atBottom = useRef(true);
  const lastRange = useRef<{ first: number; last: number; version?: number }>({ first: -1, last: -1 });

  const scale = gridScale.value;
  const own = (c: Column<R>) => Math.round((widths[c.key] ?? c.width) * scale);
  const ownTotal = columns.reduce((s, c) => s + own(c), 0);
  const fillCol = columns.find((c) => c.fill);
  const width = (c: Column<R>) => (c === fillCol ? Math.max(own(c), own(c) + viewportW - ownTotal) : own(c));
  const totalWidth = columns.reduce((s, c) => s + width(c), 0);
  const bodyViewport = Math.max(0, viewport - HEAD_H);
  const { first, last } = visibleRange(scrollTop, bodyViewport, rowH, rowCount);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setViewport(el.clientHeight);
      setViewportW(el.clientWidth);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    props.controller?.({
      scrollToRow: (i) => {
        const el = ref.current;
        if (!el) return;
        el.scrollTop = scrollTopForRow(i, el.scrollTop, el.clientHeight - HEAD_H, rowH);
        setScrollTop(el.scrollTop);
      },
      focus: () => ref.current?.focus(),
    });
  });

  // автоследование: пока пользователь внизу, новые строки прокручивают таблицу
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !props.follow || !atBottom.current) return;
    el.scrollTop = el.scrollHeight;
    setScrollTop(el.scrollTop);
  }, [rowCount, props.follow]);

  // диапазон просим заново и при смене версии данных: после сброса кэша (новый трейс,
  // смена фильтра) видимые строки те же, но их уже нет
  useEffect(() => {
    const r = lastRange.current;
    if (r.first !== first || r.last !== last || r.version !== props.version) {
      lastRange.current = { first, last, version: props.version };
      props.onRange?.(first, last);
    }
  });

  const changed = () => {
    setTick((n) => n + 1);
    props.onSelectionChange?.();
  };

  const select = (e: MouseEvent, i: number) => {
    if (!selection) return;
    if (e.button === 2 && selection.has(i)) return;
    if (multi && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault(); // Shift/Ctrl-клик выделяет строки, а не текст страницы
      ref.current?.focus();
    }
    if (multi && e.shiftKey) selection.shiftClick(i);
    else if (multi && (e.metaKey || e.ctrlKey) && e.button === 0) selection.ctrlClick(i);
    else selection.click(i);
    changed();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (props.onKey?.(e)) return;
    if (!selection || rowCount === 0) return;
    const page = Math.max(1, Math.floor(bodyViewport / rowH) - 1);
    const moves: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      PageDown: page,
      PageUp: -page,
      Home: -rowCount,
      End: rowCount,
    };
    if (e.key in moves && !e.ctrlKey && !e.metaKey) {
      selection.move(moves[e.key], rowCount, Boolean(multi && e.shiftKey));
      const el = ref.current!;
      el.scrollTop = scrollTopForRow(selection.focus ?? 0, el.scrollTop, el.clientHeight - HEAD_H, rowH);
      setScrollTop(el.scrollTop);
      changed();
      e.preventDefault();
    } else if (e.key === "Enter" && selection.focus != null && !e.ctrlKey) {
      props.onActivate?.(selection.focus);
      e.preventDefault();
    }
  };

  const startResize = (e: PointerEvent, c: Column<R>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width(c);
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(c.minWidth ?? 32, Math.round(startW + ev.clientX - startX));
      setWidths((old) => ({ ...old, [c.key]: Math.round((w / scale) * 10) / 10 }));
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      setWidths((old) => {
        saveWidths(gridId, old);
        return old;
      });
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  };

  const rows = [];
  for (let i = first; i < last; i++) {
    const row = getRow(i);
    const sel = selection?.has(i);
    const focus = selection?.focus === i;
    const cls = row ? props.rowClass?.(row, i) : "loading";
    rows.push(
      <div
        key={i}
        class={`gr${i % 2 ? " odd" : ""}${sel ? " sel" : ""}${focus ? " focus" : ""}${cls ? ` ${cls}` : ""}`}
        style={{ top: `${i * rowH}px`, height: `${rowH}px` }}
        role="row"
        aria-rowindex={i + 1}
        aria-selected={sel ? "true" : undefined}
        onMouseDown={(e) => select(e, i)}
        onDblClick={() => props.onActivate?.(i)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.onContextMenu?.(e, i);
        }}
      >
        {columns.map((c) => (
          <div class={`gc${c.align ? ` ${c.align}` : ""}`} style={{ width: `${width(c)}px` }} role="gridcell">
            {row ? c.render(row, i) : null}
          </div>
        ))}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      class="grid"
      role="grid"
      aria-label={props.ariaLabel}
      aria-rowcount={rowCount}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        atBottom.current = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight, rowH);
        setScrollTop(el.scrollTop);
      }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onContextMenu?.(e, null);
      }}
    >
      <div class="grid-head" role="row" style={{ width: `${totalWidth}px` }}>
        {columns.map((c) => (
          <div class={`gh${c.align ? ` ${c.align}` : ""}`} role="columnheader" style={{ width: `${width(c)}px` }} title={c.title_hint}>
            {c.title}
            <span class="gh-resize" onPointerDown={(e) => startResize(e, c)} />
          </div>
        ))}
      </div>
      <div class="grid-body" style={{ height: `${rowCount * rowH}px`, width: `${totalWidth}px` }}>
        {rows}
      </div>
      {rowCount === 0 && props.emptyText ? <div class="grid-empty">{props.emptyText}</div> : null}
    </div>
  );
}
