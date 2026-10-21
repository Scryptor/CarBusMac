/** Статусбар главного окна: связь с прибором, прибор (пока нет подключения — найденный по
 * USB), состояние каналов, запись потока, скорость приёма и связь браузера с сервером. Не
 * влезает — ячейки сжимаются с многоточием: сначала строка прибора, найденный прибор и текст
 * ошибки (soft), потом остальные поровну; состояние, скорость приёма и связь с сервером
 * (keep) — никогда.
 * В виде отладчика вместо записи потока — ячейки отладчика (statusHooks.tracer): прогресс и
 * точка назначения передачи — keep (куда уйдёт трейс, видно всегда). Статус прибора там
 * второстепенен: строки прибора нет (она в подсказке к состоянию связи); каналы, фоновая
 * запись (коротко, без имени файла) и запись потока — soft, полный текст в подсказке;
 * текущая строка и пауза ужимаются только после них. */
import type { ComponentChildren } from "preact";
import { client } from "../core/client";
import { fmtDuration } from "../core/format";
import { store } from "../core/store";
import type { ChannelState, StatusState } from "../core/types";
import { deviceLabel, deviceOption, deviceVia, selectableDevices } from "../core/devices";
import { t } from "../i18n/ru";
import { connectHooks, toggleConnect } from "./shellActions";
import { ui } from "./ui";

function kbps(bitrate: number): string {
  const k = bitrate / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1).replace(".", ",")}k`;
}

export function channelText(n: number, ch: ChannelState): string {
  if (ch.error) return t.status.chFail(n);
  if (!ch.open) return t.status.chClosed(n);
  const parts = [ch.bitrate ? kbps(ch.bitrate) : t.status.ownRate];
  if (ch.listen_only) parts.push(t.status.listenOnly);
  if (ch.terminator) parts.push(t.status.terminator);
  return t.status.chLine(n, parts.join(", "));
}

export function deviceText(info: Record<string, unknown> | null): string {
  if (!info) return "";
  const serial = info.serial_int != null ? `№${String(info.serial_int)}` : "";
  return [info.hardware_name, info.firmware_version, serial].filter(Boolean).join(" ");
}

/** Найден ли CAN-Hacker по USB (пока нет подключения): найденный открывает «Настройки
 * устройства» — там его и выбирают; ещё не искали — ячейки нет. */
function presenceCell(): ComponentChildren {
  const snap = store.devices.value;
  const list = selectableDevices(snap);
  if (!list.length) {
    if (snap.bridge.state === "unknown") return null;
    return (
      <span class="cell soft" title={snap.hint || undefined}>
        {t.status.noDevice}
      </span>
    );
  }
  const own = store.status.value.device?.key ?? "";
  const open = () => (connectHooks.openConnectDialog ? connectHooks.openConnectDialog() : void toggleConnect());
  return (
    <button
      type="button"
      class="cell soft"
      title={list.map((d) => deviceOption(d, snap.usb.in_container, own)).join("\n")}
      onClick={open}
    >
      <span>{list.length === 1 ? t.status.deviceFound(deviceLabel(list[0])) : t.status.devicesFound(list.length)}</span>
    </button>
  );
}

/** Подсказка к прибору подключения: что сообщил сам прибор и каким путём он подключён. */
function connectedTitle(st: StatusState): string {
  const via = st.device ? `${deviceVia(st.device, store.devices.value.usb.in_container)}: ${st.device.path}` : "";
  return [deviceText(st.device_info), via].filter(Boolean).join(" — ");
}

/** Подсказка к состоянию связи в виде отладчика: ячейки прибора там нет. */
function deviceTitle(device: string, st: StatusState): string {
  const more = connectedTitle(st);
  return more && more !== device ? `${device} — ${more}` : device;
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
  const tracerView = ui.view.value === "tracer" && statusHooks.tracer;
  const captureCell =
    cap.recording || cap.count > 0 ? (
      <span
        class={tracerView ? "cell soft" : "cell"}
        title={tracerView ? `${t.stream.recording} ${cap.count} ${fmtDuration(cap.duration_s)}` : undefined}
      >
        {cap.recording ? <span class="dot rec" /> : null}
        <span>{cap.recording ? t.stream.recording : t.receive.menuStream}</span>
        <span class="mono">{cap.count}</span>
        <span class="mono">{fmtDuration(cap.duration_s)}</span>
        {cap.full ? <span class="err-text">{t.stream.full}</span> : null}
      </span>
    ) : null;
  const device = st.state === "opened" && (st.device || st.device_info) ? (st.device ? deviceLabel(st.device) : deviceText(st.device_info)) : "";
  if (conn !== "open") {
    // без связи с сервером состояние прибора, каналы и скорость приёма неизвестны —
    // устаревшее зелёное «Подключено» и застывшее «RX» не показываем
    return (
      <div class="statusbar" role="status">
        <span class="cell keep" title={t.status.server.hint}>
          <span class={`dot ${conn === "connecting" ? "busy" : "err"}`} />
          <span>{conn === "connecting" ? t.status.server.connecting : t.status.server.closed}</span>
        </span>
      </div>
    );
  }
  return (
    <div class="statusbar" role="status">
      <span class="cell keep" title={(tracerView && device ? deviceTitle(device, st) : st.message) || undefined}>
        <span class={`dot ${dotCls}`} />
        <span>{t.device.states[st.state]}</span>
      </span>
      {st.state === "error" && st.message ? (
        <span class="cell soft err-text" title={st.message}>
          {st.message}
        </span>
      ) : null}
      {device && !tracerView ? (
        <span class="cell soft" title={connectedTitle(st)}>
          {device}
        </span>
      ) : null}
      {st.state === "closed" || st.state === "error" ? presenceCell() : null}
      {channels.map(([n, ch]) => {
        const text = channelText(Number(n), ch);
        return (
          <span
            class={tracerView ? "cell soft" : "cell"}
            title={(tracerView ? [text, ch.alias].filter(Boolean).join(" — ") : ch.alias) || undefined}
          >
            {text}
          </span>
        );
      })}
      {tracerView ? (
        <>
          {statusHooks.tracer!()}
          {cap.recording ? captureCell : null}
        </>
      ) : (
        captureCell
      )}
      {st.log ? (
        <span class={tracerView ? "cell soft" : "cell"} title={tracerView ? t.status.log(st.log) : t.settings.logFolder}>
          <span class="dot rec" />
          <span>{tracerView ? t.status.logShort : t.status.log(st.log)}</span>
        </span>
      ) : null}
      <span class="cell grow" />
      {st.state === "opened" ? <span class="cell keep mono">{t.status.rx(stats.rx_per_s)}</span> : null}
    </div>
  );
}
