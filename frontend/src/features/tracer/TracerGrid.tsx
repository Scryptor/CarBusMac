/** Таблица трейса: видимые строки (без неотмеченных в таблице ID) с номером в трейсе,
 * временем, каналом, ID, данными, паузами и комментарием. Точка останова — красная
 * метка в первой колонке, текущая строка воспроизведения подсвечена, запрещённые
 * строки приглушены. Shift — диапазон, Ctrl/Cmd — отдельные строки. */
import { Flag } from "lucide-preact";
import { useMemo } from "preact/hooks";
import { runAction } from "../../core/actions";
import { fmtAscii, fmtData, fmtFlags, fmtId, fmtTime } from "../../core/format";
import { commentKey, store } from "../../core/store";
import type { TracerRowJson } from "../../core/types";
import { t } from "../../i18n/ru";
import { openContextMenu } from "../../ui/ContextMenu";
import type { MenuItem } from "../../ui/Menu";
import { VirtualGrid, type Column } from "../../ui/grid/VirtualGrid";
import {
  fetchTracerRange,
  idKey,
  tracerCache,
  tracerFound,
  tracerGrid,
  tracerSel,
  tracerSelVersion,
  tracerVersion,
} from "./tracerStore";

/** Пункты контекстного меню таблицы; правку строк добавляет features/tracer (H2). */
export const tracerMenuHooks: { extra: () => MenuItem[] } = { extra: () => [] };

export function tracerMenu(): MenuItem[] {
  return [
    { action: "tracerPlay" },
    { action: "tracerStep" },
    { action: "tracerStop" },
    { separator: true },
    ...tracerMenuHooks.extra(),
    { separator: true },
    { action: "tracerBp" },
    { action: "tracerCopyTx" },
    { action: "tracerComment" },
    { separator: true },
    { action: "tracerCancelSel" },
  ];
}

const delays = (r: TracerRowJson) => (r.before_ms || r.after_ms ? `${r.before_ms} / ${r.after_ms}` : "");

export function TracerGrid() {
  const st = store.tracer.value;
  const comments = store.comments.value;
  const found = tracerFound.value;
  const current = st.current;

  const columns: Column<TracerRowJson>[] = useMemo(
    () => [
      {
        key: "bp",
        title: "",
        width: 26,
        align: "center",
        render: (r) => (r.bp ? <span class="bp-dot" title={t.tracer.bpTitle} aria-label={t.tracer.bpTitle} /> : null),
      },
      { key: "n", title: t.tracer.colNum, width: 76, align: "right", render: (r) => r.i + 1 },
      {
        key: "time",
        title: t.col.time,
        width: 96,
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
      { key: "flags", title: t.col.flags, width: 64, render: (r) => fmtFlags({ rtr: r.rtr, fd: false, brs: false }) },
      { key: "ch", title: t.col.ch, width: 40, align: "center", render: (r) => <span class={`ch-tag${r.ch === 2 ? " ch2" : ""}`}>{r.ch}</span> },
      { key: "id", title: t.col.id, width: 96, align: "right", render: (r) => fmtId(r.id, r.ext, true) },
      { key: "dlc", title: t.col.dlc, width: 44, align: "center", render: (r) => r.dlc },
      { key: "data", title: t.col.data, width: 222, render: (r) => fmtData(r.data).map((b) => <span class="byte">{b}</span>) },
      { key: "ascii", title: t.col.ascii, width: 88, render: (r) => fmtAscii(r.data) },
      { key: "delays", title: t.tracer.colDelays, width: 92, align: "right", render: delays, title_hint: t.tracer.delaysHint },
      {
        key: "comment",
        title: t.col.comment,
        fill: true,
        width: 200,
        render: (r) =>
          r.marker ? (
            <b>
              {r.marker.label}
              {r.marker.comment ? ` — ${r.marker.comment}` : ""}
            </b>
          ) : (
            r.comment || comments[commentKey(r.id, r.ext)] || ""
          ),
      },
    ],
    [comments],
  );

  const rowClass = (r: TracerRowJson) =>
    [
      r.i === current ? "current" : "",
      r.enabled ? "" : "disabled",
      found.has(idKey(r)) ? "found" : "",
      r.marker ? "marker" : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <VirtualGrid<TracerRowJson>
      gridId="tracer"
      ariaLabel={t.tracer.title}
      columns={columns}
      rowCount={st.visible}
      getRow={(i) => tracerCache.get(i)}
      version={tracerVersion.value}
      rowClass={rowClass}
      selection={tracerSel}
      multi
      onSelectionChange={() => tracerSelVersion.value++}
      onRange={fetchTracerRange}
      onContextMenu={(e) => openContextMenu(e.clientX, e.clientY, tracerMenu())}
      onActivate={() => runAction("tracerRowEdit")}
      controller={(c) => (tracerGrid.ctl = c)}
      emptyText={st.count > 0 ? t.tracer.allHidden : t.tracer.empty}
    />
  );
}
