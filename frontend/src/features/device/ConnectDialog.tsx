/** «Настройки устройства»: мост (хост:порт) и параметры обоих каналов рядом;
 * «Принять» подключает с этими настройками (при открытом соединении — переподключает:
 * у прибора нет закрытия канала, скорость меняется только так). */
import { useState } from "preact/hooks";
import { deviceText } from "../../app/StatusBar";
import { closeDialog } from "../../app/ui";
import { cmd } from "../../core/client";
import { pushToast, store } from "../../core/store";
import type { ChannelConfig, ConnectionConfig, CustomBitrate } from "../../core/types";
import { t } from "../../i18n/ru";
import { Dialog } from "../../ui/Dialog";
import { Check } from "../../ui/Fields";
import { BitrateManager } from "./BitrateManager";
import { applyChoice, bitrateOptions, choiceOf, parseBridge } from "./deviceModel";

const DEFAULT_CLOCK_HZ = 120_000_000;

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
  channels: [defaultChannel(1), defaultChannel(2)],
};

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
        <Check checked={ch.auto_open} onChange={(v) => onChange({ ...ch, auto_open: v })} label={t.device.autoOpen} />
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
  const [chans, setChans] = useState<ChannelConfig[]>(() =>
    [1, 2].map((n) => ({ ...defaultChannel(n), ...conn.channels.find((c) => c.channel === n) })),
  );
  const [manager, setManager] = useState<number | null>(null);
  const [err, setErr] = useState("");

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
    onClose();
    cmd("connect", { config: { ...bridge, channels } }).catch((e: Error) => pushToast("error", e.message));
  };

  return (
    <Dialog title={t.device.dialog} onClose={onClose} onOk={submit} width={760}>
      <div class="group" role="group" aria-labelledby="dev-title">
        <div class="group-title" id="dev-title">
          {t.device.deviceTab}
        </div>
        <div class="form-grid">
          <span class="label">{t.device.source}</span>
          <span>{t.device.sourceBridge}</span>
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
        <div class="muted" style={{ marginTop: "8px" }}>
          {st.state === "opened" && st.device_info
            ? `${t.device.connectedDevice}: ${deviceText(st.device_info)}`
            : t.device.bridgeHint}
        </div>
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
