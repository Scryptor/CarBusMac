/** «Настройки устройства»: прибор из найденных по USB и параметры обоих каналов рядом;
 * «Принять» подключает с этими настройками (при открытом соединении — переподключает:
 * у прибора нет закрытия канала, скорость меняется только так). Список приборов живой,
 * как список источников десктопа по таймеру: пока окно открыто, сервер раз в 2 с опрашивает
 * порты (devices_scan) с адресом моста из «Дополнительно». */
import { useEffect, useRef, useState } from "preact/hooks";
import { deviceText } from "../../app/StatusBar";
import { closeDialog } from "../../app/ui";
import { cmd } from "../../core/client";
import { pushToast, store } from "../../core/store";
import type { ChannelConfig, ConnectionConfig, CustomBitrate, DeviceEntry, DevicesState } from "../../core/types";
import { t } from "../../i18n/ru";
import { Dialog } from "../../ui/Dialog";
import { Check } from "../../ui/Fields";
import { BitrateManager } from "./BitrateManager";
import {
  applyChoice,
  asDevicesState,
  bitrateOptions,
  bridgeUnreachable,
  choiceOf,
  deviceOption,
  deviceStatus,
  deviceToSave,
  parseBridge,
  pickDevice,
  selectableDevices,
} from "./deviceModel";

const DEFAULT_CLOCK_HZ = 120_000_000;
/** Опрос портов, пока окно открыто (у десктопа таймер списка источников — 500 мс). */
const SCAN_MS = 2000;
/** Точка строки состояния прибора: тон → класс .dot */
const DOT = { ok: "ok", warn: "busy", err: "err", idle: "" } as const;

const defaultChannel = (n: number): ChannelConfig => ({
  channel: n,
  alias: "",
  bitrate: 500_000,
  timing: null,
  listen_only: false,
  terminator: false,
  auto_open: n === 1,
});

const DEFAULT_CONNECTION: ConnectionConfig = {
  bridge_host: "host.docker.internal",
  bridge_port: 7000,
  device: "",
  channels: [defaultChannel(1), defaultChannel(2)],
};

/** Сразу и раз в SCAN_MS просит сервер опросить порты с адресом моста из полей (пока адрес
 * неверный — не просит). Возвращает последний разобранный ответ, до него — null. Сбои опроса
 * молчат: остаётся прежний снимок. */
function useDevicesScan(host: string, port: string): DevicesState | null {
  const [scanned, setScanned] = useState<DevicesState | null>(null);
  // таймер один на всё время окна — текущий адрес он берёт отсюда
  const addr = useRef({ host, port });
  addr.current = { host, port };
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const scan = () => {
      if (inFlight) return; // прошлый опрос ещё идёт (адрес не отвечает) — запросы не копим
      let bridge;
      try {
        bridge = parseBridge(addr.current.host, addr.current.port);
      } catch {
        return;
      }
      inFlight = true;
      cmd("devices_scan", bridge)
        .then((r) => {
          const snap = asDevicesState(r);
          if (alive && snap) setScanned(snap);
        })
        .catch(() => {}) // без тостов: следующий опрос через SCAN_MS
        .finally(() => {
          inFlight = false;
        });
    };
    scan();
    const timer = setInterval(scan, SCAN_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return scanned;
}

function ChannelGroup({ ch, customs, terminatorOk, onChange, onConfigure }: {
  ch: ChannelConfig;
  customs: CustomBitrate[];
  /** false — прибор сообщил, что терминатора нет; undefined — неизвестно */
  terminatorOk: boolean | undefined;
  onChange: (c: ChannelConfig) => void;
  onConfigure: () => void;
}) {
  const id = `dev-ch${ch.channel}`;
  const noTerm = terminatorOk === false;
  return (
    <div class="group" role="group" aria-labelledby={`${id}-title`}>
      <div class="group-title" id={`${id}-title`}>
        {t.device.channelTab(ch.channel)}
      </div>
      <div class="form-stack">
        <label for={`${id}-alias`}>{t.device.alias}</label>
        <input
          id={`${id}-alias`}
          class="inp"
          maxLength={16}
          value={ch.alias}
          onInput={(e) => onChange({ ...ch, alias: (e.target as HTMLInputElement).value })}
        />
        <label for={`${id}-rate`}>{t.device.nominal}</label>
        <span class="inline-row">
          <select
            id={`${id}-rate`}
            class="inp grow"
            value={choiceOf(ch, customs)}
            onChange={(e) => onChange({ ...ch, ...applyChoice((e.target as HTMLSelectElement).value, ch, customs) })}
          >
            {bitrateOptions(customs, ch).map((o) => (
              <option value={o.value}>{o.label}</option>
            ))}
          </select>
          <button type="button" class="btn small" title={t.device.configure} aria-label={t.device.configure} onClick={onConfigure}>
            …
          </button>
        </span>
      </div>
      <div class="check-list">
        <Check checked={ch.listen_only} onChange={(v) => onChange({ ...ch, listen_only: v })} label={t.device.listenOnly} />
        <Check
          checked={!noTerm && ch.terminator}
          disabled={noTerm}
          title={noTerm ? t.device.noTerminator : undefined}
          onChange={(v) => onChange({ ...ch, terminator: v })}
          label={t.device.terminator}
        />
        <Check
          checked={ch.auto_open}
          onChange={(v) => onChange({ ...ch, auto_open: v })}
          label={t.device.autoOpen}
          title={t.device.autoOpenHint}
        />
      </div>
    </div>
  );
}

export function ConnectDialog({ onClose = closeDialog }: { onClose?: () => void }) {
  const conn = store.connection.value ?? DEFAULT_CONNECTION;
  const st = store.status.value;
  const customs = store.bitrates.value;
  const [host, setHost] = useState(conn.bridge_host);
  const [port, setPort] = useState(String(conn.bridge_port));
  // прибор, выбранный в этом окне ("" — пользователь не выбирал)
  const [choice, setChoice] = useState("");
  const snap = useDevicesScan(host, port) ?? store.devices.value;
  const unreachable = bridgeUnreachable(snap);
  const [more, setMore] = useState(unreachable);
  const [chans, setChans] = useState<ChannelConfig[]>(() =>
    [1, 2].map((n) => ({ ...defaultChannel(n), ...conn.channels.find((c) => c.channel === n) })),
  );
  const [manager, setManager] = useState<number | null>(null);
  const [err, setErr] = useState("");

  // мост не отвечает и приборов нет — адрес мог быть неверным: «Дополнительно» раскрываем сразу
  useEffect(() => {
    if (unreachable) setMore(true);
  }, [unreachable]);

  const saved = conn.device ?? "";
  const list = selectableDevices(snap);
  // чужие порты (монитор, плата) видны в списке неактивными — понятно, почему их не предлагают
  const others = snap.devices.filter((d) => !d.selectable);
  const own = st.device?.key ?? "";
  const picked = pickDevice(choice, saved, list, st.state === "opened" ? own : "");
  const status = deviceStatus(snap, choice, picked, st.state === "opened" ? own : "");
  const option = (d: DeviceEntry) => deviceOption(d, snap.usb.in_container, own);

  const feats = st.device_info?.channel_features;
  const terminatorOk = (n: number) => (feats ? Boolean(feats[String(n)]?.terminator) : undefined);
  const clockOf = (n: number) => st.device_info?.channel_frequencies?.[String(n)];
  const setChan = (c: ChannelConfig) => setChans(chans.map((x) => (x.channel === c.channel ? c : x)));

  const submit = () => {
    let bridge;
    try {
      bridge = parseBridge(host, port);
    } catch (e) {
      setErr((e as Error).message);
      setMore(true); // поля адреса — в «Дополнительно»
      return;
    }
    if (list.length > 1 && !picked) {
      setErr(t.device.errPick);
      return;
    }
    const channels = chans.map((c) => ({
      channel: c.channel,
      alias: c.alias.trim(),
      bitrate: c.bitrate,
      timing: c.timing,
      listen_only: c.listen_only,
      terminator: terminatorOk(c.channel) === false ? false : c.terminator,
      auto_open: c.auto_open,
    }));
    const config: ConnectionConfig = { ...bridge, device: deviceToSave(picked, saved, list), channels };
    // сразу запоминаем принятое: повторно открытый диалог покажет его, а не старый снимок
    // (нормализованный конфиг сервер пришлёт событием connection)
    store.connection.value = config;
    onClose();
    cmd("connect", { config }).catch((e: Error) => pushToast("error", e.message));
  };

  return (
    <Dialog title={t.device.dialog} onClose={onClose} onOk={submit} width={760}>
      <div class="group" role="group" aria-labelledby="dev-title">
        <div class="group-title" id="dev-title">
          {t.device.deviceTab}
        </div>
        <div class="form-grid">
          <label for="dev-device">{t.device.instrument}</label>
          <select
            id="dev-device"
            class="inp"
            style={{ width: "100%" }}
            value={picked}
            disabled={!list.length}
            onChange={(e) => {
              setChoice((e.target as HTMLSelectElement).value);
              setErr("");
            }}
          >
            {!list.length ? <option value="">{t.device.noInstrument}</option> : null}
            {list.length > 1 && !picked ? (
              <option value="" disabled>
                {t.device.pickInstrument}
              </option>
            ) : null}
            {list.map((d) => (
              <option key={d.key} value={d.key}>
                {option(d)}
              </option>
            ))}
            {list.length > 0 && others.length > 0 ? (
              <optgroup label={t.device.otherPorts}>
                {others.map((d) => (
                  <option key={d.key} value={d.key} disabled>
                    {option(d)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <div class="dev-status" role="status" aria-live="polite">
            <span class={`dot ${DOT[status.tone]}`} />
            <span>{status.text}</span>
          </div>
        </div>
        {st.state === "opened" && st.device_info && !st.device ? (
          <div class="muted" style={{ marginTop: "8px" }}>
            {`${t.device.connectedDevice}: ${deviceText(st.device_info)}`}
          </div>
        ) : null}
        <details class="dev-more" open={more} onToggle={(e) => setMore((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>{t.device.more}</summary>
          <div class="form-grid">
            <label for="dev-host">{t.device.bridge}</label>
            <span class="inline-row">
              <input
                id="dev-host"
                class="inp mono"
                style={{ width: "260px" }}
                aria-label={t.device.bridgeHost}
                value={host}
                spellcheck={false}
                onInput={(e) => setHost((e.target as HTMLInputElement).value)}
              />
              <span>:</span>
              <input
                class="inp mono"
                style={{ width: "76px" }}
                aria-label={t.device.bridgePort}
                value={port}
                inputMode="numeric"
                onInput={(e) => setPort((e.target as HTMLInputElement).value)}
              />
            </span>
          </div>
          <p class="muted">{t.device.bridgeAbout}</p>
        </details>
      </div>
      <div class="dev-channels">
        {chans.map((c) => (
          <ChannelGroup
            ch={c}
            customs={customs}
            terminatorOk={terminatorOk(c.channel)}
            onChange={setChan}
            onConfigure={() => setManager(c.channel)}
          />
        ))}
      </div>
      <div class="err-line" role={err ? "alert" : undefined}>
        {err}
      </div>
      {manager != null ? (
        <BitrateManager
          clockHz={clockOf(manager) ?? DEFAULT_CLOCK_HZ}
          clockKnown={clockOf(manager) != null}
          onClose={() => setManager(null)}
          onSaved={(_list, added) => {
            const c = chans.find((x) => x.channel === manager);
            if (added && c) setChan({ ...c, bitrate: added.bitrate, timing: { ...added.timing } });
          }}
        />
      ) : null}
    </Dialog>
  );
}
