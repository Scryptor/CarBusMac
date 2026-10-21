/** Вид «Отладчик» (F12): строка опций (как pnAddActions десктопа), таблица трейса и
 * таблица используемых ID справа; меню, тулбар и статус вида регистрирует register.tsx.
 * Вид размонтируется при выходе в главное окно — прокрутку таблицы он помнит сам. */
import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { ui } from "../../app/ui";
import { store } from "../../core/store";
import { t } from "../../i18n/ru";
import { Check } from "../../ui/Fields";
import { Splitter } from "../../ui/Splitter";
import { setPlayer } from "./DelayMenu";
import { IdTable } from "./IdTable";
import { TracerGrid } from "./TracerGrid";
import { fetchTracerIds, tracerRev, tracerScrollTo } from "./tracerStore";

const IDS_MIN = 240;
const IDS_MAX = 520;

/** Прокрутка таблицы трейса между заходами в отладчик (F12 → F12): иначе таблица вставала
 * бы в начало, а курсор — за экран. Только для того же трейса и тех же позиций строк
 * (ревизия): после смены трейса или чужой правки прежняя прокрутка ни к чему. */
const kept = { top: 0, rev: Number.NaN, current: null as number | null };

function useKeptScroll(box: RefObject<HTMLDivElement>): void {
  useLayoutEffect(() => {
    const grid = box.current?.querySelector<HTMLElement>(".grid");
    if (!grid) return;
    const st = store.tracer.peek();
    if (kept.rev === tracerRev()) {
      grid.scrollTop = kept.top;
      // пока вид был закрыт, воспроизведение ушло дальше — показать, где оно
      if (st.state !== "stopped" && st.pos != null && st.current !== kept.current) tracerScrollTo.value = { pos: st.pos };
    }
    const save = () => {
      kept.top = grid.scrollTop;
      kept.rev = tracerRev();
      kept.current = store.tracer.peek().current;
    };
    grid.addEventListener("scroll", save);
    return () => {
      grid.removeEventListener("scroll", save);
      if (grid.isConnected) save();
    };
  }, []);
}

function OptionsRow() {
  const st = store.tracer.value;
  const c = st.config;
  const multi = st.channels.length > 1;
  // выбранный канал виден, даже если в нынешнем трейсе его нет, и список не блокируется,
  // пока выбор не сброшен (сбросить его иначе было бы нечем)
  const chosen = c.only_channel;
  const options = chosen != null && !st.channels.includes(chosen) ? [...st.channels, chosen].sort((a, b) => a - b) : st.channels;
  return (
    <div class="tr-options">
      <Check checked={c.stop_on_rx} onChange={(v) => setPlayer({ stop_on_rx: v })} label={t.tracer.stopOnRx} />
      <label class="field" title={multi ? undefined : t.tracer.onlyChannelHint}>
        <span>{t.tracer.onlyChannel}</span>
        <select
          class="inp"
          aria-label={t.tracer.onlyChannel}
          disabled={!multi && chosen == null}
          value={chosen == null ? "" : String(chosen)}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            setPlayer({ only_channel: v ? Number(v) : null });
          }}
        >
          <option value="">{t.tracer.allChannels}</option>
          {options.map((n) => (
            <option value={String(n)}>{t.tracer.destCh(n)}</option>
          ))}
        </select>
      </label>
      <Check checked={c.stop_on_bp} onChange={(v) => setPlayer({ stop_on_bp: v })} label={t.tracer.stopOnBp} />
      <span class="tool-spacer" />
      <span class="tr-name" title={st.name ?? undefined}>
        {st.name ?? t.tracer.untitled}
        {st.modified ? <span class="muted"> — {t.tracer.modified}</span> : null}
      </span>
      <span class="tr-rows">{t.tracer.rows(st.visible, st.count)}</span>
    </div>
  );
}

export function TracerView() {
  const start = useRef(0);
  const gridBox = useRef<HTMLDivElement>(null);
  useEffect(() => fetchTracerIds(), []);
  useKeptScroll(gridBox);
  return (
    <div class="tracer">
      <OptionsRow />
      <div class="tr-body">
        <div class="tr-grid" ref={gridBox}>
          <TracerGrid />
        </div>
        {ui.tracerIdsOpen.value ? (
          <>
            <Splitter
              dir="row"
              onStart={() => (start.current = ui.tracerIdsWidth.value)}
              onDrag={(d) => {
                ui.tracerIdsWidth.value = Math.min(IDS_MAX, Math.max(IDS_MIN, start.current - d));
              }}
            />
            <aside class="tr-side" style={{ width: `${ui.tracerIdsWidth.value}px` }} aria-label={t.tracer.idTable}>
              <IdTable />
            </aside>
          </>
        ) : null}
      </div>
    </div>
  );
}
