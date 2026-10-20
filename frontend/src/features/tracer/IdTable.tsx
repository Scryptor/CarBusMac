/** Таблица используемых ID («Фильтр сообщений», Ctrl+F3): флажок — строки этого ID
 * видны и воспроизводятся; «Все»/«Сброс»; контекстное меню как pmFilter десктопа.
 * Пробел переключает флажки выделенных ID. */
import { useMemo } from "preact/hooks";
import { cmd } from "../../core/client";
import { fmtId } from "../../core/format";
import { pushToast } from "../../core/store";
import type { TracerIdJson } from "../../core/types";
import { t } from "../../i18n/ru";
import { openContextMenu } from "../../ui/ContextMenu";
import type { MenuItem } from "../../ui/Menu";
import { Selection } from "../../ui/grid/selection";
import { VirtualGrid, type Column } from "../../ui/grid/VirtualGrid";
import { idKey, tracerFound, tracerGrid, tracerIds, tracerSel, tracerSelVersion } from "./tracerStore";

const toastErr = (e: Error) => pushToast("error", e.message);
const keyOf = (r: TracerIdJson) => [r.ch, r.id, r.ext];

export function setIdsEnabled(rows: TracerIdJson[], enabled: boolean): void {
  const changed = rows.filter((r) => r.enabled !== enabled);
  if (changed.length) cmd("tracer_ids_set", { keys: changed.map(keyOf), enabled }).catch(toastErr);
}

/** Позиции строк трейса с этими ID (среди видимых). */
async function positionsOf(rows: TracerIdJson[]): Promise<number[]> {
  const parts = await Promise.all(rows.map((r) => cmd<{ positions: number[] }>("tracer_find", { key: keyOf(r) })));
  return parts.flatMap((p) => p.positions ?? []).sort((a, b) => a - b);
}

function findMessages(rows: TracerIdJson[]): void {
  const keys = rows.map(idKey);
  const cur = tracerFound.value;
  const allOn = keys.every((k) => cur.has(k));
  const next = new Set(cur);
  for (const k of keys) {
    if (allOn) next.delete(k);
    else next.add(k);
  }
  tracerFound.value = next;
  if (allOn) return;
  positionsOf(rows)
    .then((ps) => {
      const from = tracerSel.focus ?? -1;
      const first = ps.find((p) => p > from) ?? ps[0];
      if (first != null) tracerGrid.ctl?.scrollToRow(first);
    })
    .catch(toastErr);
}

function selectMessages(rows: TracerIdJson[], on: boolean): void {
  positionsOf(rows)
    .then((ps) => {
      if (on) tracerSel.addMany(ps);
      else tracerSel.removeMany(ps);
      tracerSelVersion.value++;
    })
    .catch(toastErr);
}

function enableMessages(rows: TracerIdJson[], enabled: boolean): void {
  for (const r of rows) cmd("tracer_rows_enable", { key: keyOf(r), enabled }).catch(toastErr);
}

function idMenu(targets: TracerIdJson[]): MenuItem[] {
  const all = tracerIds.value;
  const none = targets.length === 0;
  return [
    { label: t.tracer.idsClearAll, run: () => setIdsEnabled(all, false) },
    { label: t.tracer.idsSetAll, run: () => setIdsEnabled(all, true) },
    {
      label: t.tracer.idsInvert,
      run: () => {
        setIdsEnabled(all.filter((r) => r.enabled), false);
        setIdsEnabled(all.filter((r) => !r.enabled), true);
      },
    },
    { separator: true },
    { label: t.tracer.idsFind, disabled: none, run: () => findMessages(targets) },
    { separator: true },
    { label: t.tracer.idsSelect, disabled: none, run: () => selectMessages(targets, true) },
    { label: t.tracer.idsDeselect, disabled: none, run: () => selectMessages(targets, false) },
    { separator: true },
    { label: t.tracer.idsDisable, disabled: none, run: () => enableMessages(targets, false) },
    { label: t.tracer.idsEnable, disabled: none, run: () => enableMessages(targets, true) },
  ];
}

export function IdTable() {
  const ids = tracerIds.value;
  const found = tracerFound.value;
  const sel = useMemo(() => new Selection(), []);
  const targets = (i: number | null) => {
    const picked = sel.selected().map((k) => ids[k]).filter(Boolean);
    if (i != null && !sel.has(i)) return ids[i] ? [ids[i]] : [];
    return picked;
  };
  const columns: Column<TracerIdJson>[] = [
    {
      key: "on",
      title: "",
      width: 30,
      align: "center",
      render: (r) => (
        <input
          type="checkbox"
          class="row-check"
          aria-label={t.tracer.idCheck(fmtId(r.id, r.ext, true), r.ch)}
          checked={r.enabled}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={() => setIdsEnabled([r], !r.enabled)}
        />
      ),
    },
    { key: "ch", title: t.col.ch, width: 40, align: "center", render: (r) => <span class={`ch-tag${r.ch === 2 ? " ch2" : ""}`}>{r.ch}</span> },
    { key: "id", title: t.col.id, width: 96, align: "right", render: (r) => fmtId(r.id, r.ext, true) },
    { key: "count", title: t.tracer.colCount, width: 80, align: "right", render: (r) => r.count },
  ];
  const shown = ids.filter((r) => r.enabled).length;
  return (
    <div class="tr-ids">
      <div class="tr-ids-head">
        <button type="button" class="btn small" onClick={() => setIdsEnabled(ids, true)}>
          {t.tracer.idsAll}
        </button>
        <button type="button" class="btn small" onClick={() => setIdsEnabled(ids, false)}>
          {t.tracer.idsNone}
        </button>
        <span class="tool-spacer" />
        <span class="muted">{t.tracer.idsShown(shown, ids.length)}</span>
      </div>
      <div class="tr-ids-body">
        <VirtualGrid<TracerIdJson>
          gridId="tracer-ids"
          ariaLabel={t.tracer.idTable}
          columns={columns}
          rowCount={ids.length}
          getRow={(i) => ids[i]}
          rowClass={(r) => [r.enabled ? "" : "disabled", found.has(idKey(r)) ? "found" : ""].filter(Boolean).join(" ") || undefined}
          selection={sel}
          multi
          onContextMenu={(e, i) => openContextMenu(e.clientX, e.clientY, idMenu(targets(i)))}
          onKey={(e) => {
            if (e.key !== " ") return false;
            const picked = targets(null);
            if (picked.length) setIdsEnabled(picked, !picked.every((r) => r.enabled));
            e.preventDefault();
            return true;
          }}
          emptyText={t.tracer.idsEmpty}
        />
      </div>
    </div>
  );
}
