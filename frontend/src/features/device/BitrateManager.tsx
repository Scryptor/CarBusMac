/** «Управление скоростями»: свои скорости CAN. Скорость и точка выборки подбирают
 * Делитель/Seg1/Seg2/SJW; правка тайминга руками пересчитывает фактическую скорость,
 * точку выборки и точность. Стандартные скорости прибора здесь не редактируются. */
import { ChevronDown, ChevronUp } from "lucide-preact";
import { useState } from "preact/hooks";
import { cmd } from "../../core/client";
import { store } from "../../core/store";
import type { CustomBitrate, Timing } from "../../core/types";
import { t } from "../../i18n/ru";
import { bestTiming, NOMINAL_LIMITS, timingError, timingInfo } from "../../lib/timing";
import { Dialog } from "../../ui/Dialog";
import { kbpsLabel } from "./deviceModel";

interface Draft {
  caption: string;
  rate: string; // Кбит/с
  sample: string; // %
  presc: string;
  seg1: string;
  seg2: string;
  sjw: string;
  clock_hz: number;
  noTiming: boolean;
}

const num = (s: string) => (/^\s*\d+([.,]\d+)?\s*$/.test(s) ? Number(s.trim().replace(",", ".")) : NaN);
const dec = (v: number, digits: number) => String(Number(v.toFixed(digits))).replace(".", ",");
const bpsOf = (d: Draft) => Math.round(num(d.rate) * 1000);

function toDraft(c: CustomBitrate): Draft {
  return {
    caption: c.caption,
    rate: dec(c.bitrate / 1000, 3),
    sample: dec(c.sample_pct, 2),
    presc: String(c.timing.prescaler),
    seg1: String(c.timing.seg1),
    seg2: String(c.timing.seg2),
    sjw: String(c.timing.sjw),
    clock_hz: c.clock_hz,
    noTiming: false,
  };
}

const timingOf = (d: Draft): Timing => ({ prescaler: num(d.presc), seg1: num(d.seg1), seg2: num(d.seg2), sjw: num(d.sjw) });

function draftError(d: Draft): string | null {
  if (!(bpsOf(d) > 0)) return t.bitrate.errRate;
  const sp = num(d.sample);
  if (!(sp >= 50 && sp <= 90)) return t.bitrate.errSample;
  return timingError(timingOf(d)) ?? (d.noTiming ? t.bitrate.noTiming : null);
}

function draftLabel(d: Draft): string {
  const bps = bpsOf(d);
  const rate = bps > 0 ? kbpsLabel(bps) : "—";
  return d.caption ? `${d.caption} — ${rate}` : rate;
}

function fmtAccuracy(pct: number): string {
  if (Math.abs(pct) < 0.0005) return "0,000";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(3).replace(".", ",")}`;
}

export function BitrateManager({ clockHz, clockKnown = true, onClose, onSaved }: {
  clockHz: number;
  /** false — прибор не подключён, частота по умолчанию */
  clockKnown?: boolean;
  onClose: () => void;
  /** после сохранения: новый список и последняя добавленная скорость, если была */
  onSaved?: (list: CustomBitrate[], added: CustomBitrate | null) => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => store.bitrates.value.map(toDraft));
  const [sel, setSel] = useState<number | null>(drafts.length ? 0 : null);
  const [lastAdded, setLastAdded] = useState<Draft | null>(null);
  const [saveErr, setSaveErr] = useState("");
  const cur = sel != null ? drafts[sel] : null;
  const L = NOMINAL_LIMITS;

  const update = (patch: Partial<Draft>, retime = false) => {
    if (sel == null || !cur) return;
    let next: Draft = { ...cur, ...patch, clock_hz: clockHz };
    if (retime) {
      const bps = bpsOf(next);
      const sp = num(next.sample);
      const tm = bps > 0 && sp >= 50 && sp <= 90 ? bestTiming(bps, clockHz, sp) : null;
      next = tm
        ? { ...next, presc: String(tm.prescaler), seg1: String(tm.seg1), seg2: String(tm.seg2), sjw: String(tm.sjw), noTiming: false }
        : { ...next, noTiming: bps > 0 && sp >= 50 && sp <= 90 };
    }
    const list = drafts.slice();
    list[sel] = next;
    if (lastAdded === cur) setLastAdded(next);
    setDrafts(list);
    setSaveErr("");
  };

  const add = () => {
    const tm = bestTiming(500_000, clockHz, 75)!;
    const d: Draft = {
      caption: "",
      rate: "500",
      sample: "75",
      presc: String(tm.prescaler),
      seg1: String(tm.seg1),
      seg2: String(tm.seg2),
      sjw: String(tm.sjw),
      clock_hz: clockHz,
      noTiming: false,
    };
    setDrafts([...drafts, d]);
    setSel(drafts.length);
    setLastAdded(d);
  };
  const remove = () => {
    if (sel == null) return;
    const list = drafts.filter((_, i) => i !== sel);
    setDrafts(list);
    setSel(list.length ? Math.min(sel, list.length - 1) : null);
  };
  const move = (dir: -1 | 1) => {
    if (sel == null) return;
    const j = sel + dir;
    if (j < 0 || j >= drafts.length) return;
    const list = drafts.slice();
    [list[sel], list[j]] = [list[j], list[sel]];
    setDrafts(list);
    setSel(j);
  };

  const save = () => {
    const bad = drafts.findIndex((d) => draftError(d) != null);
    if (bad >= 0) {
      setSel(bad);
      setSaveErr(draftError(drafts[bad]) ?? "");
      return;
    }
    const list: CustomBitrate[] = drafts.map((d) => ({
      caption: d.caption.trim(),
      bitrate: bpsOf(d),
      sample_pct: num(d.sample),
      clock_hz: d.clock_hz,
      timing: timingOf(d),
    }));
    const addedIdx = lastAdded ? drafts.indexOf(lastAdded) : -1;
    cmd("bitrates_set", { bitrates: list })
      .then(() => {
        store.bitrates.value = list;
        onSaved?.(list, addedIdx >= 0 ? list[addedIdx] : null);
        onClose();
      })
      .catch((e: Error) => setSaveErr(e.message));
  };

  const err = cur ? draftError(cur) : null;
  const info = cur && !timingError(timingOf(cur)) ? timingInfo(timingOf(cur), clockHz, bpsOf(cur) || undefined) : null;
  const field = (id: string, label: string, value: string, onInput: (v: string) => void, unit: string, mono = true) => (
    <>
      <label for={id}>{label}</label>
      <input
        id={id}
        class={"inp" + (mono ? " mono" : "")}
        value={value}
        disabled={!cur}
        spellcheck={false}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
      />
      <span class="muted">{unit}</span>
    </>
  );
  const readonly = (id: string, label: string, value: string, unit: string) => (
    <>
      <label for={id}>{label}</label>
      <input id={id} class="inp mono" value={value} readOnly tabIndex={-1} />
      <span class="muted">{unit}</span>
    </>
  );

  return (
    <Dialog title={t.device.bitrates} onClose={onClose} onOk={save} width={700}>
      <div class="muted">
        {t.bitrate.clock(clockHz / 1_000_000)}
        {clockKnown ? "" : ` — ${t.bitrate.clockDefault}`}
      </div>
      <div class="br-layout">
        <div class="br-side">
          <div
            class="br-list"
            role="listbox"
            aria-label={t.bitrate.list}
            tabIndex={0}
            onKeyDown={(e) => {
              if (sel == null) return;
              if (e.key === "ArrowDown" && sel < drafts.length - 1) setSel(sel + 1);
              else if (e.key === "ArrowUp" && sel > 0) setSel(sel - 1);
              else return;
              e.preventDefault();
            }}
          >
            {drafts.length ? (
              drafts.map((d, i) => (
                <div role="option" aria-selected={i === sel} class={"br-item" + (i === sel ? " sel" : "")} onClick={() => setSel(i)}>
                  {draftLabel(d)}
                </div>
              ))
            ) : (
              <div class="muted br-empty">{t.bitrate.empty}</div>
            )}
          </div>
          <div class="br-buttons">
            <button type="button" class="btn small" onClick={add}>
              {t.common.add}
            </button>
            <button type="button" class="btn small" disabled={sel == null} onClick={remove}>
              {t.common.remove}
            </button>
            <button type="button" class="btn small" aria-label={t.bitrate.up} title={t.bitrate.up} disabled={!sel} onClick={() => move(-1)}>
              <ChevronUp size={15} />
            </button>
            <button
              type="button"
              class="btn small"
              aria-label={t.bitrate.down}
              title={t.bitrate.down}
              disabled={sel == null || sel >= drafts.length - 1}
              onClick={() => move(1)}
            >
              <ChevronDown size={15} />
            </button>
          </div>
        </div>
        <div class="br-form">
          {field("br-caption", t.bitrate.caption, cur?.caption ?? "", (v) => update({ caption: v }), "", false)}
          {field("br-rate", t.bitrate.rate, cur?.rate ?? "", (v) => update({ rate: v }, true), t.bitrate.kbps)}
          {field("br-sample", t.bitrate.sample, cur?.sample ?? "", (v) => update({ sample: v }, true), t.bitrate.samplePct)}
          <hr />
          {field("br-presc", t.bitrate.prescaler, cur?.presc ?? "", (v) => update({ presc: v, noTiming: false }), `${L.presc[0]}..${L.presc[1]}`)}
          {field("br-seg1", t.bitrate.seg1, cur?.seg1 ?? "", (v) => update({ seg1: v, noTiming: false }), `${L.seg1[0]}..${L.seg1[1]}`)}
          {field("br-seg2", t.bitrate.seg2, cur?.seg2 ?? "", (v) => update({ seg2: v, noTiming: false }), `${L.seg2[0]}..${L.seg2[1]}`)}
          {field("br-sjw", t.bitrate.sjw, cur?.sjw ?? "", (v) => update({ sjw: v, noTiming: false }), `${L.sjw[0]}..${L.sjw[1]}`)}
          <hr />
          {readonly("br-actual", t.bitrate.actualRate, info ? dec(info.bitrate / 1000, 3) : "", t.bitrate.kbps)}
          {readonly("br-actual-sp", t.bitrate.actualSample, info ? dec(info.samplePct, 2) : "", "%")}
          {readonly("br-accuracy", t.bitrate.accuracy, info ? fmtAccuracy(info.accuracyPct) : "", "%")}
        </div>
      </div>
      <div class="err-line" role={err || saveErr ? "alert" : undefined}>
        {err ?? saveErr}
      </div>
    </Dialog>
  );
}
