/** Виртуальный грид (аналог TDrawGrid десктопа): рисует только видимые строки,
 * шапка закреплена, ширины колонок тянутся и запоминаются, выделение мышью и
 * клавиатурой, контекстное меню, автоследование за концом (поток, отладчик).
 * Миллионы строк: тело не выше MAX_BODY_PX (предел высоты элемента в Chrome), позиция
 * в таблице хранится отдельно от прокрутки элемента и пересчитывается с коэффициентом. */
import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { isAtBottom, physToVirt, rowTop, scrollGeom, scrollTopForRow, virtToPhys, visibleRange } from "./gridMath";
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

/** Мак: Ctrl+клик — это вторичный (правый) клик, отдельные строки выделяются по Cmd. */
function isMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform || nav.platform || "");
}

/** Прокрутка, выставленная самим гридом (автоследование, переход к строке): по ней
 * контекстное меню не закрывается — только по прокрутке пользователя. */
const ownScroll = new WeakMap<Element, { top: number; left: number }>();

export function isOwnScroll(el: Element): boolean {
  const own = ownScroll.get(el);
  return own !== undefined && Math.abs(el.scrollTop - own.top) < 1 && Math.abs(el.scrollLeft - own.left) < 1;
}

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
  // phys — прокрутка элемента, virt — позиция в «полной» таблице (px от первой строки);
  // пока строк немного, они совпадают
  const [pos, setPos] = useState({ phys: 0, virt: 0 });
  const posRef = useRef(pos);
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
  const geom = scrollGeom(rowCount, rowH, bodyViewport);
  const { first, last } = visibleRange(pos.virt, bodyViewport, rowH, rowCount);

  const place = (phys: number, virt: number) => {
    posRef.current = { phys, virt };
    setPos(posRef.current);
  };

  /** Прокрутить к позиции в таблице: элемент — на соответствующую прокрутку. */
  const scrollToVirt = (el: HTMLDivElement, virt: number) => {
    const vp = el.clientHeight - HEAD_H;
    const g = scrollGeom(rowCount, rowH, vp);
    const v = Math.min(g.maxVirt, Math.max(0, virt));
    el.scrollTop = virtToPhys(v, g);
    const phys = el.scrollTop; // браузер мог округлить
    ownScroll.set(el, { top: phys, left: el.scrollLeft });
    const at = g.k === 1 ? phys : v;
    // «у конца» — сразу по цели, а не со следующим scroll: иначе переход к строке во время
    // записи («Перейти к метке») новые кадры тут же утягивали бы обратно в конец
    atBottom.current = isAtBottom(at, vp, g.total, rowH);
    place(phys, at);
  };
  const scrollToVirtRef = useRef(scrollToVirt);
  scrollToVirtRef.current = scrollToVirt;

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
        scrollToVirt(el, scrollTopForRow(i, posRef.current.virt, el.clientHeight - HEAD_H, rowH));
      },
      focus: () => ref.current?.focus(),
    });
  });

  // автоследование: пока пользователь внизу, новые строки прокручивают таблицу; иначе при
  // масштабе (коэффициент зависит от числа строк) держим ту же позицию в таблице
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (props.follow && atBottom.current) scrollToVirt(el, Number.MAX_SAFE_INTEGER);
    else if (geom.k !== 1 || posRef.current.virt !== posRef.current.phys) scrollToVirt(el, posRef.current.virt);
  }, [rowCount, props.follow, rowH, bodyViewport]);

  // колесо при масштабе: браузер прокрутил бы элемент, а таблицу — в k раз дальше
  const scaled = geom.k !== 1;
  useEffect(() => {
    const el = ref.current;
    if (!el || !scaled) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // жест масштаба страницы
      const unit = e.deltaMode === 1 ? rowHeight.peek() : e.deltaMode === 2 ? el.clientHeight - HEAD_H : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
      if (!dy) return; // горизонтальную прокрутку браузер делает сам
      e.preventDefault();
      if (dx) el.scrollLeft += dx;
      scrollToVirtRef.current(el, posRef.current.virt + dy);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scaled]);

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
    const mac = isMac();
    // правый клик (и Ctrl+клик на маке — он же вторичный) по выделенной строке не сбрасывает
    // выделение, по невыделенной — выделяет её одну: меню относится к ней
    const secondary = e.button === 2 || (mac && e.ctrlKey);
    if (secondary && selection.has(i)) return;
    const toggle = !secondary && (mac ? e.metaKey : e.ctrlKey || e.metaKey);
    const extend = !secondary && e.shiftKey;
    if (multi && (extend || toggle)) {
      e.preventDefault(); // Shift/Ctrl-клик выделяет строки, а не текст страницы
      ref.current?.focus();
    }
    if (multi && extend) selection.shiftClick(i);
    else if (multi && toggle && e.button === 0) selection.ctrlClick(i);
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
      scrollToVirt(el, scrollTopForRow(selection.focus ?? 0, posRef.current.virt, el.clientHeight - HEAD_H, rowH));
      changed();
      e.preventDefault();
    } else if (scaled && e.key === " " && e.target === e.currentTarget && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // пробел листает страницу; при масштабе браузер пролистал бы в k раз дальше
      scrollToVirt(ref.current!, posRef.current.virt + (e.shiftKey ? -1 : 1) * Math.max(rowH, bodyViewport - rowH));
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
        style={{ top: `${rowTop(i, rowH, pos.phys, pos.virt)}px`, height: `${rowH}px` }}
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
        const vp = el.clientHeight - HEAD_H;
        const g = scrollGeom(rowCount, rowH, vp);
        const phys = el.scrollTop;
        const prev = posRef.current;
        // своя прокрутка (или только горизонтальная) — позиция в таблице та же, точная;
        // иначе пользователь тянет ползунок — пересчитываем с коэффициентом
        const virt = g.k !== 1 && Math.abs(phys - prev.phys) < 1 ? prev.virt : physToVirt(phys, g);
        atBottom.current = isAtBottom(virt, vp, g.total, rowH);
        place(phys, virt);
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
      <div class="grid-body" style={{ height: `${geom.body}px`, width: `${totalWidth}px` }}>
        {rows}
      </div>
      {rowCount === 0 && props.emptyText ? <div class="grid-empty">{props.emptyText}</div> : null}
    </div>
  );
}
