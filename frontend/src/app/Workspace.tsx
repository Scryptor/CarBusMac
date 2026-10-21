/** Рабочая область главного окна: приём слева сверху, панель фильтров справа, док
 * передачи снизу (размеры тянутся сплиттерами и запоминаются); отладчик — отдельный вид. */
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n/ru";
import { Splitter } from "../ui/Splitter";
import { ui } from "./ui";

/** Слоты панелей; фичи подставляют свои компоненты (см. features). */
export const slots: {
  receive: (() => ComponentChildren) | null;
  filters: (() => ComponentChildren) | null;
  transmit: (() => ComponentChildren) | null;
  tracer: (() => ComponentChildren) | null;
} = { receive: null, filters: null, transmit: null, tracer: null };

/** Минимум дока передачи: вкладка, таблица задач на шапку и строку и редактор целиком
 * (три строки полей, столбец кнопок до «Удалить»); замерено в Chrome. */
export const DOCK_MIN = 200;
/** Док не выше этой доли рабочей области — монитору всегда остаётся место. */
const DOCK_SHARE = 0.65;
const FILTERS_MIN = 260;
const FILTERS_MAX = 560;

/** Высота дока для отрисовки: сохранённое значение в пределах окна. localStorage помнит
 * размер с большого экрана — на 1366×650 он закрыл бы монитор, а низ редактора ушёл бы
 * под статусбар. Сохранённое значение не меняем: в большом окне оно вернётся. */
export function clampDock(h: number, wsHeight: number): number {
  const max = Math.max(DOCK_MIN, Math.round(wsHeight * DOCK_SHARE));
  return Math.min(max, Math.max(DOCK_MIN, h));
}

function Placeholder({ title }: { title: string }) {
  return (
    <div class="panel">
      <div class="panel-head">{title}</div>
      <div class="panel-empty muted">…</div>
    </div>
  );
}

export function Workspace() {
  const wsRef = useRef<HTMLDivElement>(null);
  const startDock = useRef(0);
  const startFilters = useRef(0);
  const view = ui.view.value;
  // высота рабочей области: предел дока пересчитывается при изменении окна
  const [wsHeight, setWsHeight] = useState(0);
  useLayoutEffect(() => {
    const el = wsRef.current;
    if (!el) return;
    const measure = () => setWsHeight(el.clientHeight);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [view]);

  if (view === "tracer") {
    return <div class="workspace">{slots.tracer?.() ?? <Placeholder title={t.tracer.title} />}</div>;
  }

  // пока высота не измерена (0) — только минимум
  const dockHeight = wsHeight > 0 ? clampDock(ui.dockHeight.value, wsHeight) : Math.max(DOCK_MIN, ui.dockHeight.value);
  return (
    <div class="workspace" ref={wsRef}>
      <div class="main-area">
        <section class="receive-area" aria-label={t.receive.monitor}>
          {slots.receive?.() ?? <Placeholder title={t.receive.monitor} />}
        </section>
        {ui.filtersOpen.value ? (
          <>
            <Splitter
              dir="row"
              onStart={() => (startFilters.current = ui.filtersWidth.value)}
              onDrag={(d) => {
                ui.filtersWidth.value = Math.min(FILTERS_MAX, Math.max(FILTERS_MIN, startFilters.current - d));
              }}
            />
            <aside class="side-panel" style={{ width: `${ui.filtersWidth.value}px` }} aria-label={t.filters.title}>
              {slots.filters?.() ?? <Placeholder title={t.filters.title} />}
            </aside>
          </>
        ) : null}
      </div>
      {ui.dockOpen.value ? (
        <>
          <Splitter
            dir="col"
            onStart={() => (startDock.current = dockHeight)}
            onDrag={(d) => {
              ui.dockHeight.value = clampDock(startDock.current - d, wsRef.current?.clientHeight ?? wsHeight);
            }}
          />
          <section class="dock" style={{ height: `${dockHeight}px` }} aria-label={t.tx.tab}>
            {slots.transmit?.() ?? <Placeholder title={t.tx.tab} />}
          </section>
        </>
      ) : null}
    </div>
  );
}
