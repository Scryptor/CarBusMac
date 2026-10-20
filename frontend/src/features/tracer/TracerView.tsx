/** Вид «Отладчик» (F12): строка опций (как pnAddActions десктопа), таблица трейса и
 * таблица используемых ID справа; меню, тулбар и статус вида регистрирует register.tsx. */
import { useEffect, useRef } from "preact/hooks";
import { ui } from "../../app/ui";
import { store } from "../../core/store";
import { t } from "../../i18n/ru";
import { Check } from "../../ui/Fields";
import { Splitter } from "../../ui/Splitter";
import { setPlayer } from "./DelayMenu";
import { IdTable } from "./IdTable";
import { TracerGrid } from "./TracerGrid";
import { fetchTracerIds } from "./tracerStore";

const IDS_MIN = 240;
const IDS_MAX = 520;

function OptionsRow() {
  const st = store.tracer.value;
  const c = st.config;
  const multi = st.channels.length > 1;
  return (
    <div class="tr-options">
      <Check checked={c.stop_on_rx} onChange={(v) => setPlayer({ stop_on_rx: v })} label={t.tracer.stopOnRx} />
      <label class="field" title={multi ? undefined : t.tracer.onlyChannelHint}>
        <span>{t.tracer.onlyChannel}</span>
        <select
          class="inp"
          aria-label={t.tracer.onlyChannel}
          disabled={!multi}
          value={c.only_channel == null ? "" : String(c.only_channel)}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            setPlayer({ only_channel: v ? Number(v) : null });
          }}
        >
          <option value="">{t.tracer.allChannels}</option>
          {st.channels.map((n) => (
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
  useEffect(() => fetchTracerIds(), []);
  return (
    <div class="tracer">
      <OptionsRow />
      <div class="tr-body">
        <div class="tr-grid">
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
