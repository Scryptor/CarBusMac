/** Область приёма: заголовок «Приём [ Монитор ]» / «Приём [ Поток данных ]» и
 * таблица — монитор, раздельный приём по каналам или поток. */
import type { ComponentChildren } from "preact";
import { ui } from "../../app/ui";
import { store } from "../../core/store";
import { t } from "../../i18n/ru";
import { MonitorPanel, monitorStore } from "./MonitorGrid";

/** Слоты вида приёма: поток (Task 17) и раздельный приём (Task 15). */
export const receiveSlots: { stream: (() => ComponentChildren) | null; split: (() => ComponentChildren) | null } = {
  stream: null,
  split: null,
};

export function ReceiveArea() {
  const mode = ui.receiveMode.value;
  const s = store.settings.value;
  monitorStore.version.value;
  const body =
    mode === "stream"
      ? receiveSlots.stream?.()
      : ui.split.value && receiveSlots.split
        ? receiveSlots.split()
        : <MonitorPanel />;
  return (
    <div class="panel">
      <div class="panel-head">
        <span>{mode === "stream" ? t.receive.stream : t.receive.monitor}</span>
        {mode === "monitor" ? <span class="muted">ID: {monitorStore.size}</span> : null}
        {mode === "stream" ? (
          <span class="muted">
            {t.col.count}: {store.capture.value.count}
            {store.capture.value.markers.length ? `, меток: ${store.capture.value.markers.length}` : ""}
          </span>
        ) : null}
        {store.capture.value.recording ? (
          <span class="rec-badge">
            <span class="dot rec" /> {t.stream.recording}
          </span>
        ) : null}
        <span class="spacer" />
        {mode === "monitor" && s.rare_mode ? (
          <span class="muted">
            {t.rare.highlight}: от {s.rare_period_ms} {t.common.ms}
          </span>
        ) : null}
      </div>
      <div class="panel-body">{body}</div>
    </div>
  );
}
