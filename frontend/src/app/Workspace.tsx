/** Рабочая область главного окна: приём слева сверху, панель фильтров справа, док
 * передачи снизу (размеры тянутся сплиттерами и запоминаются); отладчик — отдельный вид. */
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
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

const DOCK_MIN = 150;
const FILTERS_MIN = 260;
const FILTERS_MAX = 560;

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

  if (ui.view.value === "tracer") {
    return <div class="workspace">{slots.tracer?.() ?? <Placeholder title={t.tracer.title} />}</div>;
  }

  const dockMax = () => Math.max(DOCK_MIN, Math.round((wsRef.current?.clientHeight ?? 600) * 0.65));
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
            onStart={() => (startDock.current = ui.dockHeight.value)}
            onDrag={(d) => {
              ui.dockHeight.value = Math.min(dockMax(), Math.max(DOCK_MIN, startDock.current - d));
            }}
          />
          <section class="dock" style={{ height: `${ui.dockHeight.value}px` }} aria-label={t.tx.tab}>
            {slots.transmit?.() ?? <Placeholder title={t.tx.tab} />}
          </section>
        </>
      ) : null}
    </div>
  );
}
