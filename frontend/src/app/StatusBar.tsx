/** Статусбар главного окна: связь с прибором, прибор, состояние каналов, запись потока,
 * скорость приёма и связь браузера с сервером. */
import type { ComponentChildren } from "preact";
import { client } from "../core/client";
import { fmtDuration } from "../core/format";
import { store } from "../core/store";
import type { ChannelState } from "../core/types";
import { t } from "../i18n/ru";
import { ui } from "./ui";

function kbps(bitrate: number): string {
  const k = bitrate / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1).replace(".", ",")}k`;
}

export function channelText(n: number, ch: ChannelState): string {
  if (ch.error) return `К${n}: отказ`;
  if (!ch.open) return `К${n}: закрыт`;
  const parts = [ch.timing && !ch.bitrate ? "своя скорость" : ch.bitrate ? kbps(ch.bitrate) : "своя скорость"];
  if (ch.listen_only) parts.push("только прослушивание");
  if (ch.terminator) parts.push("120 Ом");
  return `К${n}: ${parts.join(", ")}`;
}

export function deviceText(info: Record<string, unknown> | null): string {
  if (!info) return "";
  const serial = info.serial_int != null ? `№${String(info.serial_int)}` : "";
  return [info.hardware_name, info.firmware_version, serial].filter(Boolean).join(" ");
}

/** Ячейки статуса вида отладчика (строит features/tracer) — вместо ячейки записи потока. */
export const statusHooks: { tracer: (() => ComponentChildren) | null } = { tracer: null };

export function StatusBar() {
  const st = store.status.value;
  const cap = store.capture.value;
  const stats = store.stats.value;
  const conn = client.state.value;
  const dotCls = st.state === "opened" ? "ok" : st.state === "error" ? "err" : st.state === "opening" ? "busy" : "";
  const channels = Object.entries(st.channels);
  const captureCell =
    cap.recording || cap.count > 0 ? (
      <span class="cell">
        {cap.recording ? <span class="dot rec" /> : null}
        <span>{cap.recording ? t.stream.recording : t.receive.menuStream}</span>
        <span class="mono">{cap.count}</span>
        <span class="mono">{fmtDuration(cap.duration_s)}</span>
        {cap.full ? <span class="err-text">{t.stream.full}</span> : null}
      </span>
    ) : null;
  const tracerView = ui.view.value === "tracer" && statusHooks.tracer;
  return (
    <div class="statusbar" role="status">
      <span class="cell" title={st.message || undefined}>
        <span class={`dot ${dotCls}`} />
        <span>{t.device.states[st.state]}</span>
        {st.state === "error" && st.message ? <span class="err-text">{st.message}</span> : null}
      </span>
      {st.device_info ? <span class="cell">{deviceText(st.device_info)}</span> : null}
      {channels.map(([n, ch]) => (
        <span class="cell" title={ch.alias || undefined}>
          {channelText(Number(n), ch)}
        </span>
      ))}
      {tracerView ? (
        <>
          {statusHooks.tracer!()}
          {cap.recording ? captureCell : null}
        </>
      ) : (
        captureCell
      )}
      <span class="cell grow" />
      {st.state === "opened" ? <span class="cell mono">{t.status.rx(stats.rx_per_s)}</span> : null}
      {conn !== "open" ? (
        <span class="cell">
          <span class="dot err" />
          {conn === "connecting" ? t.status.server.connecting : t.status.server.closed}
        </span>
      ) : null}
    </div>
  );
}
