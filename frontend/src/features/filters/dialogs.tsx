/** Диалоги фильтров: «Установить фильтр по маске», «Фильтр на диапазон»,
 * «Исключение из диапазона». В простом режиме маска скрыта (= все биты ID). */
import { useState } from "preact/hooks";
import { closeDialog } from "../../app/ui";
import { cmd } from "../../core/client";
import { fmtHex, parseHexId } from "../../core/format";
import { store } from "../../core/store";
import type { HwSlotJson, RangeExclusionJson, RangeFilterJson } from "../../core/types";
import { t } from "../../i18n/ru";
import { Dialog } from "../../ui/Dialog";
import { Check, Select } from "../../ui/Fields";
import { parseExcludeList, rangeWithExcludeList } from "./filtersModel";

const full = (ext: boolean) => (ext ? 0x1fffffff : 0x7ff);
const hexOf = (v: number, ext: boolean) => fmtHex(v, ext ? 8 : 3);

export function HwFilterDialog({ slot }: { slot: HwSlotJson }) {
  const simple = store.settings.value.filter_simple_mode;
  const [id, setId] = useState(hexOf(slot.can_id, slot.ext));
  const [mask, setMask] = useState(hexOf(slot.mask, slot.ext));
  const [ext, setExt] = useState(slot.ext);
  const [enabled, setEnabled] = useState(slot.enabled || slot.can_id === 0);
  const [err, setErr] = useState("");
  const save = () => {
    try {
      const can_id = parseHexId(id, ext);
      const m = simple ? full(ext) : parseHexId(mask, ext);
      cmd("hw_set", { slot: { ...slot, can_id, mask: m, ext, enabled } })
        .then(closeDialog)
        .catch((e: Error) => setErr(e.message));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Dialog title={`${t.filters.hwDialog} — ${t.receive.channelCaption(slot.channel, "")}, Num ${slot.index}`} onClose={closeDialog} onOk={save} okLabel={t.common.set} width={440}>
      <div class="form-grid">
        <label for="hw-id">{t.col.id}</label>
        <input id="hw-id" class="inp mono" value={id} maxLength={8} onInput={(e) => setId((e.target as HTMLInputElement).value.toUpperCase())} />
        {simple ? null : (
          <>
            <label for="hw-mask">{t.col.mask}</label>
            <input id="hw-mask" class="inp mono" value={mask} maxLength={8} title={t.filters.maskHint} onInput={(e) => setMask((e.target as HTMLInputElement).value.toUpperCase())} />
          </>
        )}
      </div>
      {simple ? null : <div class="muted">{t.filters.maskHint}</div>}
      <Check checked={ext} onChange={setExt} label={t.filters.bit29} />
      <Check checked={enabled} onChange={setEnabled} label={t.filters.enable} />
      <div class="err-line">{err}</div>
    </Dialog>
  );
}

export function RangeFilterDialog({ range }: { range: RangeFilterJson | null }) {
  const r: RangeFilterJson = range ?? { id: "", channel: 1, enabled: true, start: 0, end: 0x7ff, exclusions: [] };
  const [channel, setChannel] = useState(String(r.channel));
  const [from, setFrom] = useState(fmtHex(r.start, r.start > 0x7ff ? 8 : 3));
  const [to, setTo] = useState(fmtHex(r.end, r.end > 0x7ff ? 8 : 3));
  const [enabled, setEnabled] = useState(r.enabled);
  const [exclude, setExclude] = useState(r.exclusions.map((e) => fmtHex(e.can_id, e.can_id > 0x7ff ? 8 : 3)).join(", "));
  const [err, setErr] = useState("");
  const save = () => {
    try {
      const start = parseHexId(from, true);
      const end = parseHexId(to, true);
      const next = rangeWithExcludeList({ ...r, channel: Number(channel), enabled, start, end }, parseExcludeList(exclude));
      cmd("range_upsert", { filter: next })
        .then(closeDialog)
        .catch((e: Error) => setErr(e.message));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Dialog title={t.filters.rangeDialog} onClose={closeDialog} onOk={save} okLabel={t.common.set} width={480}>
      <div class="group">
        <div class="group-title">{t.filters.range}</div>
        <div class="form-grid">
          <label>{t.tx.channel}</label>
          <Select value={channel} options={[{ value: "1", label: "1" }, { value: "2", label: "2" }]} onChange={setChannel} label={t.tx.channel} />
          <label for="rg-from">{t.filters.from}</label>
          <input id="rg-from" class="inp mono" value={from} maxLength={8} onInput={(e) => setFrom((e.target as HTMLInputElement).value.toUpperCase())} />
          <label for="rg-to">{t.filters.to}</label>
          <input id="rg-to" class="inp mono" value={to} maxLength={8} onInput={(e) => setTo((e.target as HTMLInputElement).value.toUpperCase())} />
        </div>
        <div style={{ marginTop: "8px" }}>
          <Check checked={enabled} onChange={setEnabled} label={t.filters.enable} />
        </div>
      </div>
      <div class="group">
        <div class="group-title">{t.filters.exclude}</div>
        <label class="field stack">
          <span>{t.filters.excludeList}</span>
          <input class="inp mono" aria-label={t.filters.excludeList} value={exclude} onInput={(e) => setExclude((e.target as HTMLInputElement).value.toUpperCase())} />
        </label>
        <div class="muted" style={{ marginTop: "6px" }}>
          {t.filters.excludeHint}
        </div>
      </div>
      <div class="err-line">{err}</div>
    </Dialog>
  );
}

export function ExclusionDialog({ range, index }: { range: RangeFilterJson; index: number | null }) {
  const simple = store.settings.value.filter_simple_mode;
  const ex: RangeExclusionJson = index != null ? range.exclusions[index] : { enabled: true, can_id: range.start, mask: 0x7ff };
  const [id, setId] = useState(fmtHex(ex.can_id, ex.can_id > 0x7ff ? 8 : 3));
  const [mask, setMask] = useState(fmtHex(ex.mask, ex.mask > 0x7ff ? 8 : 3));
  const [enabled, setEnabled] = useState(ex.enabled);
  const [err, setErr] = useState("");
  const save = () => {
    try {
      const can_id = parseHexId(id, true);
      const m = simple ? full(can_id > 0x7ff) : parseHexId(mask, true);
      const exclusions = range.exclusions.slice();
      const item = { enabled, can_id, mask: m };
      if (index != null) exclusions[index] = item;
      else exclusions.push(item);
      cmd("range_upsert", { filter: { ...range, exclusions } })
        .then(closeDialog)
        .catch((e: Error) => setErr(e.message));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Dialog title={t.filters.exclusionDialog} onClose={closeDialog} onOk={save} okLabel={t.common.set} width={420}>
      <div class="form-grid">
        <label for="ex-id">{t.col.id}</label>
        <input id="ex-id" class="inp mono" value={id} maxLength={8} onInput={(e) => setId((e.target as HTMLInputElement).value.toUpperCase())} />
        {simple ? null : (
          <>
            <label for="ex-mask">{t.col.mask}</label>
            <input id="ex-mask" class="inp mono" value={mask} maxLength={8} onInput={(e) => setMask((e.target as HTMLInputElement).value.toUpperCase())} />
          </>
        )}
      </div>
      {simple ? null : <div class="muted">{t.filters.maskHint}</div>}
      <Check checked={enabled} onChange={setEnabled} label={t.filters.enableExclusion} />
      <div class="err-line">{err}</div>
    </Dialog>
  );
}
