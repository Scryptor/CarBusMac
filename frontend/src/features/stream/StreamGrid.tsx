/** Режим «Поток» (окно «Поток принимаемых данных» десктопа): хронология Rx и Tx с
 * временем, метками и комментариями. Строки хранит бэкенд, таблица подгружает
 * видимые страницы, а пока пользователь внизу — следует за новыми кадрами. */
import { signal } from "@preact/signals";
import { Flag } from "lucide-preact";
import { useMemo } from "preact/hooks";
import { runAction } from "../../core/actions";
import { client, cmd } from "../../core/client";
import { fmtAscii, fmtData, fmtFlags, fmtId, fmtTime } from "../../core/format";
import { commentKey, store } from "../../core/store";
import type { FrameRowJson } from "../../core/types";
import { t } from "../../i18n/ru";
import { openContextMenu } from "../../ui/ContextMenu";
import type { MenuItem } from "../../ui/Menu";
import { Selection } from "../../ui/grid/selection";
import { VirtualGrid, type Column, type GridController } from "../../ui/grid/VirtualGrid";
import { StreamCache } from "./streamCache";

export const streamCache = new StreamCache<FrameRowJson>(200);
export const streamVersion = signal(0);
export const streamSelection = signal<FrameRowJson | null>(null);
export const streamGrid: { ctl: GridController | null } = { ctl: null };
let rev = -1;

function syncRev(r: number): void {
  if (r !== rev) {
    rev = r;
    streamCache.reset();
  }
}

client.on("capture_tail", (e) => {
  syncRev(Number(e.rev));
  streamCache.applyTail(Number(e.start), e.rows as FrameRowJson[]);
  streamVersion.value++;
});
client.on("capture_state", (e) => {
  syncRev(Number(e.rev));
  streamVersion.value++;
});
client.on("hello", (e) => {
  // ревизия из снапшота: иначе после перезагрузки страницы строки не подгрузятся,
  // пока не придёт capture_state (без записи — не придёт)
  rev = Number((e.capture as { rev?: number } | undefined)?.rev ?? -1);
  streamCache.reset();
  streamVersion.value++;
});

export function fetchRange(first: number, last: number): void {
  const total = store.capture.value.count;
  for (const p of streamCache.missingPages(first, Math.min(last, total), total)) {
    streamCache.markPending(p);
    const askedRev = rev;
    cmd<{ rows: FrameRowJson[]; rev: number }>("capture_rows", { start: p * streamCache.pageSize, count: streamCache.pageSize })
      .then((d) => {
        if (d.rev === askedRev) {
          streamCache.put(p * streamCache.pageSize, d.rows);
          streamVersion.value++;
        }
      })
      .catch(() => {})
      .finally(() => streamCache.clearPending(p));
  }
}

export function streamMenu(): MenuItem[] {
  return [
    { action: "record" },
    { action: "marker" },
    { action: "markers" },
    { separator: true },
    { action: "loadStream" },
    { action: "saveStream" },
    { action: "toTracer" },
    { separator: true },
    { action: "copyStreamToTx" },
    { action: "clear", label: t.stream.clearStream },
  ];
}

export function StreamPanel() {
  const count = store.capture.value.count;
  const recording = store.capture.value.recording;
  const hex = store.settings.value.monitor_hex_ids;
  const comments = store.comments.value;
  streamVersion.value;
  const sel = useMemo(() => new Selection(), []);

  const columns: Column<FrameRowJson>[] = useMemo(
    () => [
      {
        key: "time",
        title: t.col.time,
        width: 100,
        align: "right",
        render: (r) =>
          r.marker ? (
            <span class="marker-cell" title={`${r.marker.label}${r.marker.comment ? ` — ${r.marker.comment}` : ""}`}>
              <Flag size={12} /> {fmtTime(r.t)}
            </span>
          ) : (
            fmtTime(r.t)
          ),
      },
      { key: "flags", title: t.col.flags, width: 72, render: (r) => fmtFlags({ rtr: r.rtr, fd: false, brs: false }) },
      { key: "ch", title: t.col.ch, width: 40, align: "center", render: (r) => <span class={`ch-tag${r.ch === 2 ? " ch2" : ""}`}>{r.ch}</span> },
      { key: "dir", title: t.col.rxtx, width: 52, align: "center", render: (r) => (r.dir === "tx" ? "Tx" : "Rx") },
      { key: "id", title: t.col.id, width: 96, align: "right", render: (r) => fmtId(r.id, r.ext, hex) },
      { key: "dlc", title: t.col.dlc, width: 48, align: "center", render: (r) => r.dlc },
      { key: "data", title: t.col.data, width: 222, render: (r) => fmtData(r.data).map((b) => <span class="byte">{b}</span>) },
      { key: "ascii", title: t.col.ascii, width: 92, render: (r) => fmtAscii(r.data) },
      {
        key: "comment",
        title: t.col.comment,
        fill: true,
        width: 160,
        render: (r) =>
          r.marker ? (
            <b>
              {r.marker.label}
              {r.marker.comment ? ` — ${r.marker.comment}` : ""}
            </b>
          ) : (
            comments[commentKey(r.id, r.ext)] ?? ""
          ),
      },
    ],
    [hex, comments],
  );

  return (
    <VirtualGrid<FrameRowJson>
      gridId="stream"
      ariaLabel={t.receive.stream}
      columns={columns}
      rowCount={count}
      getRow={(i) => streamCache.get(i)}
      version={streamVersion.value}
      rowClass={(r) => (r.marker ? "marker" : r.dir === "tx" ? "tx" : undefined)}
      selection={sel}
      onSelectionChange={() => {
        streamSelection.value = sel.focus != null ? streamCache.get(sel.focus) ?? null : null;
      }}
      onRange={fetchRange}
      onContextMenu={(e) => openContextMenu(e.clientX, e.clientY, streamMenu())}
      onActivate={() => runAction("copyStreamToTx")}
      follow
      controller={(c) => (streamGrid.ctl = c)}
      emptyText={recording ? t.stream.waiting : t.stream.empty}
    />
  );
}
