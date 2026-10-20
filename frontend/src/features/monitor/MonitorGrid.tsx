/** Монитор приёма (frameReceive десктопа): таблица по ID с подсветкой изменившихся
 * байтов, выделение строки, контекстное меню. Строки приходят дельтами 25 раз в секунду. */
import { signal } from "@preact/signals";
import { useMemo } from "preact/hooks";
import { runAction } from "../../core/actions";
import { client } from "../../core/client";
import { fmtAscii, fmtData, fmtFlags, fmtId, fmtPeriod } from "../../core/format";
import { commentKey, store } from "../../core/store";
import type { MonitorRowJson } from "../../core/types";
import { t } from "../../i18n/ru";
import { openContextMenu } from "../../ui/ContextMenu";
import type { MenuItem } from "../../ui/Menu";
import { Selection } from "../../ui/grid/selection";
import { VirtualGrid, type Column } from "../../ui/grid/VirtualGrid";
import { isLit } from "./highlight";
import { MonitorStore, rowKey } from "./monitorModel";

export const monitorStore = new MonitorStore();
/** Ключ выделенной строки — общий для всех гридов монитора (раздельный приём). */
export const monitorSelKey = signal<string | null>(null);
/** Выделенная строка (последние данные) — для действий F3/F4/Ctrl+↓. */
export const monitorSelection = signal<MonitorRowJson | null>(null);

monitorStore.version.subscribe(() => {
  const k = monitorSelKey.peek();
  monitorSelection.value = k ? monitorStore.get(k) ?? null : null;
});

/** Дельта с сервера: применяем с текущими настройками подсветки. */
export function ingestMonitorRows(rows: MonitorRowJson[]): void {
  monitorStore.apply(rows, performance.now(), store.settings.value);
}

client.on("monitor_delta", (e) => ingestMonitorRows(e.rows as MonitorRowJson[]));
client.on("monitor_reset", () => monitorStore.reset());
client.on("hello", (e) => {
  monitorStore.reset();
  monitorStore.apply(e.monitor as MonitorRowJson[], 0, null);
});

function DataCells({ row }: { row: MonitorRowJson }) {
  const marks = monitorStore.marks(rowKey(row.ch, row.id, row.ext));
  const now = performance.now();
  const hold = store.settings.value.mark_hold_ms;
  return (
    <>
      {fmtData(row.data).map((b, i) => {
        const st = marks[i] ?? -Infinity;
        const lit = isLit(st, now, hold);
        return (
          <span
            key={lit ? `${i}-${st}` : String(i)}
            class={lit ? "byte chg" : "byte"}
            style={lit ? { animationDelay: `-${Math.round(now - st)}ms` } : undefined}
          >
            {b}
          </span>
        );
      })}
    </>
  );
}

export function monitorColumns(
  hex: boolean,
  aggregator: boolean,
  comments: Record<string, string>,
  withCh = true,
): Column<MonitorRowJson>[] {
  const cols: Column<MonitorRowJson>[] = [];
  if (withCh) {
    cols.push({
      key: "ch",
      title: t.col.ch,
      width: 40,
      align: "center",
      render: (r) => <span class={`ch-tag${r.ch === 2 ? " ch2" : ""}`}>{r.ch}</span>,
    });
  }
  cols.push(
    { key: "flags", title: t.col.flags, width: withCh ? 72 : 64, render: (r) => fmtFlags(r) },
    { key: "id", title: t.col.id, width: withCh ? 96 : 88, align: "right", render: (r) => fmtId(r.id, r.ext, hex) },
    { key: "dlc", title: t.col.dlc, width: 48, align: "center", render: (r) => r.dlc },
    { key: "data", title: t.col.data, width: 222, render: (r) => <DataCells row={r} /> },
    { key: "period", title: t.col.period, width: withCh ? 92 : 82, align: "right", render: (r) => fmtPeriod(r.period_ms) },
    { key: "count", title: t.col.count, width: withCh ? 88 : 76, align: "right", render: (r) => r.count },
  );
  if (aggregator) cols.push({ key: "fc", title: t.col.fc, width: 56, align: "right", render: (r) => r.fc });
  cols.push(
    { key: "ascii", title: t.col.ascii, width: 92, render: (r) => fmtAscii(r.data) },
    { key: "comment", title: t.col.comment, width: 160, fill: true, render: (r) => comments[commentKey(r.id, r.ext)] ?? "" },
  );
  return cols;
}

export function monitorMenu(): MenuItem[] {
  return [
    { action: "saveRxList", label: t.rxMenu.saveRxList },
    { action: "loadStream", label: t.rxMenu.loadStream },
    { action: "clear", label: t.rxMenu.clear },
    { separator: true },
    { action: "bitmap", label: t.rxMenu.bitmap },
    { action: "frames", label: t.rxMenu.frames },
    { action: "comment", label: t.rxMenu.comment },
    { separator: true },
    { action: "copyToTx", label: t.rxMenu.copyToTx },
    { action: "addIdToFilter", label: t.rxMenu.addToFilter },
    { separator: true },
    { action: "hexIds", label: t.rxMenu.hexIds },
    { action: "sort", label: t.rxMenu.sort },
    { action: "groupByChannel", label: t.rxMenu.group },
  ];
}

export function MonitorPanel({ channel }: { channel?: number }) {
  const s = store.settings.value;
  monitorStore.version.value; // перерисовка на каждый тик
  const comments = store.comments.value;
  const keys = monitorStore
    .order(s.monitor_sort, s.monitor_group_by_channel)
    .filter((k) => channel == null || k.startsWith(`${channel}:`));
  const sel = useMemo(() => new Selection(), []);
  const selKey = monitorSelKey.value;
  const idx = selKey ? keys.indexOf(selKey) : -1;
  if (idx < 0) sel.clear();
  else if (sel.focus !== idx) sel.click(idx);

  const columns = useMemo(
    () => monitorColumns(s.monitor_hex_ids, s.aggregator, comments, channel == null),
    [s.monitor_hex_ids, s.aggregator, comments, channel],
  );
  const alias = channel != null ? store.status.value.channels[String(channel)]?.alias ?? "" : "";

  return (
    <VirtualGrid<MonitorRowJson>
      gridId={(channel != null ? "monitor-split" : "monitor") + (s.aggregator ? "-fc" : "")}
      ariaLabel={channel != null ? t.receive.channelCaption(channel, alias) : t.receive.monitor}
      columns={columns}
      rowCount={keys.length}
      getRow={(i) => monitorStore.get(keys[i])}
      version={monitorStore.version.value}
      selection={sel}
      onSelectionChange={() => {
        const k = sel.focus != null ? keys[sel.focus] : null;
        monitorSelKey.value = k ?? null;
        monitorSelection.value = k ? monitorStore.get(k) ?? null : null;
      }}
      onActivate={() => runAction("bitmap")}
      onContextMenu={(e) => openContextMenu(e.clientX, e.clientY, monitorMenu())}
      emptyText={store.status.value.state === "opened" ? t.receive.waiting : t.receive.connectFirst}
    />
  );
}
