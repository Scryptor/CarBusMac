/** «Настройки приложения» (TdlgAppSettings десктопа) и «Настройки фонового
 * логирования»: разделы слева, страница справа. Тема, шрифт, размер и цвет
 * подсветки видны сразу (предпросмотр); «Отмена» возвращает прежний вид, «Принять»
 * сохраняет всё на сервере. Окна-«в отдельном окне» десктопа здесь не нужны. */
import { useState } from "preact/hooks";
import { closeDialog } from "../../app/ui";
import { cmd } from "../../core/client";
import { parseIntRange } from "../../core/format";
import { pushToast, store } from "../../core/store";
import { applyTheme } from "../../core/theme";
import type { Settings } from "../../core/types";
import { t } from "../../i18n/ru";
import { Dialog } from "../../ui/Dialog";
import { Check } from "../../ui/Fields";

export type SettingsTab = "theme" | "font" | "receive" | "transmit" | "stream" | "filter" | "log";

const S = t.settings;
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "theme", label: S.themeTab },
  { id: "font", label: S.fontTab },
  { id: "receive", label: S.receiveTab },
  { id: "transmit", label: S.transmitTab },
  { id: "stream", label: S.streamTab },
  { id: "filter", label: S.filterTab },
  { id: "log", label: S.logTab },
];
const FONTS = ["SF Mono", "Menlo", "Monaco", "PT Mono", "Andale Mono", "Courier New"];
const COLORS = ["#e0a526", "#e8742a", "#d9534f", "#3fa34d", "#2f7be5", "#9b59b6"];
const META: { key: keyof Settings["log_meta"]; label: string }[] = [
  { key: "transport", label: S.metaTransport },
  { key: "brand", label: S.metaBrand },
  { key: "model", label: S.metaModel },
  { key: "body", label: S.metaBody },
  { key: "year", label: S.metaYear },
];

/** Предпросмотр имени файла лога — как его сделает бэкенд (strftime + безопасные символы). */
export function strftimePreview(mask: string, d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const codes: Record<string, string> = {
    Y: String(d.getFullYear()),
    y: pad(d.getFullYear() % 100),
    m: pad(d.getMonth() + 1),
    d: pad(d.getDate()),
    H: pad(d.getHours()),
    M: pad(d.getMinutes()),
    S: pad(d.getSeconds()),
    "%": "%",
  };
  return mask.replace(/%(.)/g, (m, c: string) => codes[c] ?? m);
}

function safeStem(text: string): string {
  const s = text
    .replace(/[^\p{L}\p{N}\p{M}_.\- ]/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^[._ -]+/, "")
    .replace(/[. ]+$/, "");
  return s || "log";
}

const LOOK: (keyof Settings)[] = ["theme", "grid_font", "grid_font_size", "mark_color"];

export function SettingsDialog({ onClose = closeDialog, initialTab = "theme" }: { onClose?: () => void; initialTab?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [d, setD] = useState<Settings>(() => structuredClone(store.settings.value));
  const [hold, setHold] = useState(String(store.settings.value.mark_hold_ms));
  const [err, setErr] = useState("");

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const next = { ...d, [key]: value };
    setD(next);
    if (LOOK.includes(key)) applyTheme(next);
  };
  const setMeta = (key: keyof Settings["log_meta"], value: string) => set("log_meta", { ...d.log_meta, [key]: value });

  const cancel = () => {
    applyTheme(store.settings.value);
    onClose();
  };
  const save = () => {
    let mark_hold_ms: number;
    try {
      mark_hold_ms = parseIntRange(hold, 500, 10000, S.clearAfter);
    } catch (e) {
      setErr((e as Error).message);
      setTab("receive");
      return;
    }
    onClose();
    cmd("settings_set", { patch: { ...d, mark_hold_ms } }).catch((e: Error) => {
      applyTheme(store.settings.value);
      pushToast("error", e.message);
    });
  };

  const radio = (name: string, value: boolean, onChange: (v: boolean) => void) => (
    <span class="inline-row" role="radiogroup" aria-label={name}>
      <label class="check">
        <input type="radio" name={name} checked={value} onChange={() => onChange(true)} />
        <span>{S.hex}</span>
      </label>
      <label class="check">
        <input type="radio" name={name} checked={!value} onChange={() => onChange(false)} />
        <span>{S.dec}</span>
      </label>
    </span>
  );

  const page = () => {
    switch (tab) {
      case "theme":
        return (
          <div class="form-grid">
            <label for="st-theme">{S.theme}</label>
            <select id="st-theme" class="inp" value={d.theme} onChange={(e) => set("theme", (e.target as HTMLSelectElement).value as Settings["theme"])}>
              {(["system", "light", "dark"] as const).map((v) => (
                <option value={v}>{S.themes[v]}</option>
              ))}
            </select>
          </div>
        );
      case "font":
        return (
          <>
            <div class="form-grid">
              <label for="st-font">{S.fontName}</label>
              <select id="st-font" class="inp" value={d.grid_font} onChange={(e) => set("grid_font", (e.target as HTMLSelectElement).value)}>
                {(FONTS.includes(d.grid_font) ? FONTS : [d.grid_font, ...FONTS]).map((f) => (
                  <option value={f}>{f}</option>
                ))}
              </select>
              <label for="st-size">{S.fontSize}</label>
              <select id="st-size" class="inp" style={{ width: "90px" }} value={String(d.grid_font_size)} onChange={(e) => set("grid_font_size", Number((e.target as HTMLSelectElement).value))}>
                {Array.from({ length: 8 }, (_, k) => 11 + k).map((n) => (
                  <option value={String(n)}>{n}</option>
                ))}
              </select>
            </div>
            <div class="field stack">
              <span>{S.sample}</span>
              <div class="font-sample mono">
                {S.sampleRows.map((r) => (
                  <div>{r}</div>
                ))}
              </div>
            </div>
          </>
        );
      case "receive":
        return (
          <div class="check-list">
            <Check checked={d.mark_changed} onChange={(v) => set("mark_changed", v)} label={S.markChanged} />
            <div class="inline-row">
              <span class="muted">{S.markColor}</span>
              {COLORS.map((c) => (
                <button
                  type="button"
                  class={"swatch" + (d.mark_color.toLowerCase() === c ? " on" : "")}
                  style={{ background: c }}
                  aria-label={S.colorPreset(c)}
                  aria-pressed={d.mark_color.toLowerCase() === c}
                  onClick={() => set("mark_color", c)}
                />
              ))}
              <input type="color" class="color-inp" aria-label={S.markColor} value={d.mark_color} onInput={(e) => set("mark_color", (e.target as HTMLInputElement).value)} />
            </div>
            <span class="inline-row">
              <label for="st-hold">{S.clearAfter}</label>
              <input id="st-hold" class="inp mono" style={{ width: "80px" }} inputMode="numeric" value={hold} onInput={(e) => setHold((e.target as HTMLInputElement).value)} />
              <span class="muted">{t.common.ms}</span>
            </span>
            <Check checked={d.aggregator} onChange={(v) => set("aggregator", v)} label={S.aggregator} />
          </div>
        );
      case "transmit":
        return (
          <div class="check-list">
            <Check checked={d.restore_tx_on_start} onChange={(v) => set("restore_tx_on_start", v)} label={S.restoreTx} />
          </div>
        );
      case "stream":
        return (
          <>
            <div class="check-list">
              <Check checked={d.tracer_max_1s} onChange={(v) => set("tracer_max_1s", v)} label={S.max1s} />
            </div>
            <div class="group" role="group" aria-labelledby="st-copy">
              <div class="group-title" id="st-copy">
                {S.copyFormat}
              </div>
              <div class="check-list">
                <Check checked={d.copy_header} onChange={(v) => set("copy_header", v)} label={S.copyHeader} />
                <div class="form-grid">
                  <span class="label">{S.copyId}</span>
                  {radio(S.copyId, d.copy_id_hex, (v) => set("copy_id_hex", v))}
                  <span class="label">{S.copyData}</span>
                  {radio(S.copyData, d.copy_data_hex, (v) => set("copy_data_hex", v))}
                </div>
              </div>
            </div>
          </>
        );
      case "filter":
        return (
          <div class="check-list">
            <Check checked={d.filter_new_active} onChange={(v) => set("filter_new_active", v)} label={S.newActive} />
            <Check checked={d.filter_restore_on_start} onChange={(v) => set("filter_restore_on_start", v)} label={S.restoreFilter} />
            <Check checked={d.filter_simple_mode} onChange={(v) => set("filter_simple_mode", v)} label={S.simpleMode} />
          </div>
        );
      case "log":
        return (
          <>
            <div class="check-list">
              <Check checked={d.log_autostart} onChange={(v) => set("log_autostart", v)} label={S.logAuto} />
              <Check checked={d.log_record_tx} onChange={(v) => set("log_record_tx", v)} label={S.logTx} />
            </div>
            <div class="field stack">
              <label for="st-mask">{S.logMask}</label>
              <input id="st-mask" class="inp mono" value={d.log_name_mask} spellcheck={false} onInput={(e) => set("log_name_mask", (e.target as HTMLInputElement).value)} />
              <span class="muted">{S.logMaskHint}</span>
              <span>{S.logName(safeStem(strftimePreview(d.log_name_mask || "%Y-%m-%d_%H-%M-%S", new Date())))}</span>
              <span class="muted">{S.logFolder}</span>
            </div>
            <div class="group" role="group" aria-labelledby="st-meta">
              <div class="group-title" id="st-meta">
                {S.meta}
              </div>
              <div class="form-grid">
                {META.map((m) => (
                  <>
                    <label for={`st-meta-${m.key}`}>{m.label}</label>
                    <input id={`st-meta-${m.key}`} class="inp" value={d.log_meta[m.key]} maxLength={64} onInput={(e) => setMeta(m.key, (e.target as HTMLInputElement).value)} />
                  </>
                ))}
              </div>
            </div>
          </>
        );
    }
  };

  return (
    <Dialog title={S.dialog} onClose={cancel} onOk={save} width={780}>
      <div class="settings">
        <div class="settings-tabs" role="tablist" aria-orientation="vertical" aria-label={S.dialog}>
          {TABS.map((x) => (
            <button type="button" role="tab" aria-selected={x.id === tab} class={"settings-tab" + (x.id === tab ? " on" : "")} onClick={() => setTab(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <div class="settings-page" role="tabpanel" aria-label={TABS.find((x) => x.id === tab)?.label}>
          {page()}
        </div>
      </div>
      <div class="err-line" role={err ? "alert" : undefined}>
        {err}
      </div>
    </Dialog>
  );
}
