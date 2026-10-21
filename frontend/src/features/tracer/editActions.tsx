/** Правка трейса — контекстное меню таблицы (pmTrace десктопа) и его хоткеи:
 * Ins / Ctrl+Ins / Ctrl+Enter / Ctrl+Del, копирование строк Ctrl+C, запрет и разрешение
 * строк, начало и конец воспроизведения, список (Ctrl+F5) и сброс (Shift+F5) точек,
 * комментарий строки. После удаления курсор встаёт на следующую строку — Ctrl+Del можно
 * нажимать подряд. */
import { ListOrdered } from "lucide-preact";
import { openDialog } from "../../app/ui";
import type { Action } from "../../core/actions";
import { cmd } from "../../core/client";
import { pushToast, store } from "../../core/store";
import type { TracerRowJson } from "../../core/types";
import { t } from "../../i18n/ru";
import { confirmDialog } from "../../ui/confirm";
import type { MenuItem } from "../../ui/Menu";
import { BreakpointsDialog } from "./BreakpointsDialog";
import { copyRows, TRACE_COPY_COLUMNS } from "./copyRows";
import { RowCommentDialog } from "./RowCommentDialog";
import { RowEditorDialog } from "./RowEditorDialog";
import {
  cursorRow,
  focusedRow,
  hasCursor,
  placeCursorAfter,
  tracerCache,
  tracerSel,
  tracerSelVersion,
  type CursorReply,
} from "./tracerStore";

const toastErr = (e: Error) => pushToast("error", e.message);
const PAGE = 2000;
/** Больше строк в буфер обмена не кладём — таблица Excel всё равно столько не покажет удобно. */
export const COPY_MAX = 100_000;

const hasSelection = () => (tracerSelVersion.value, tracerSel.size > 0);
const cursorPos = () => tracerSel.focus;
const selectedPositions = () => (tracerSel.size ? tracerSel.selected() : tracerSel.focus != null ? [tracerSel.focus] : []);

/** Строки по позициям: из кэша, недостающие — с сервера, подряд идущими кусками. */
async function rowsAt(positions: number[]): Promise<TracerRowJson[]> {
  const out = new Map<number, TracerRowJson>();
  const missing: number[] = [];
  for (const p of positions) {
    const r = tracerCache.get(p);
    if (r) out.set(p, r);
    else missing.push(p);
  }
  let k = 0;
  while (k < missing.length) {
    const start = missing[k];
    let end = start;
    while (k + 1 < missing.length && missing[k + 1] === end + 1 && end - start + 1 < PAGE) end = missing[++k];
    k++;
    const d = await cmd<{ rows: TracerRowJson[] }>("tracer_rows", { start, count: end - start + 1 });
    for (const r of d.rows ?? []) out.set(r.pos, r);
  }
  return positions.map((p) => out.get(p)).filter((r): r is TracerRowJson => r != null);
}

async function copySelected(): Promise<void> {
  const all = selectedPositions();
  const positions = all.slice(0, COPY_MAX);
  const rows = await rowsAt(positions);
  const s = store.settings.value;
  const text = copyRows(rows, TRACE_COPY_COLUMNS, {
    header: s.copy_header,
    idHex: s.copy_id_hex,
    dataHex: s.copy_data_hex,
    idComments: store.comments.value,
  });
  await navigator.clipboard.writeText(text);
  pushToast(all.length > COPY_MAX ? "warning" : "info", t.tracer.copied(rows.length, all.length));
}

const editRow = (mode: "add" | "insert" | "edit") =>
  cursorRow()
    .then((base) => {
      if (mode !== "add" && !base) return;
      openDialog(<RowEditorDialog mode={mode} base={base} />);
    })
    .catch(toastErr);

const deleteRows = (positions: number[]) =>
  cmd<CursorReply>("tracer_rows_delete", { positions })
    .then((d) => placeCursorAfter(d?.rev, d?.pos))
    .catch(toastErr);

const enablePositions = (positions: number[], enabled: boolean) =>
  void cmd("tracer_rows_enable", { positions, enabled }).catch(toastErr);

const enableById = (enabled: boolean) =>
  cursorRow()
    .then((r) => r && cmd("tracer_rows_enable", { key: [r.ch, r.id, r.ext], enabled }))
    .catch(toastErr);

const setBound = (which: "start" | "finish") => {
  const pos = cursorPos();
  if (pos != null) cmd("tracer_bounds", { which, pos }).catch(toastErr);
};

export function editActions(): Action[] {
  return [
    { id: "tracerRowAdd", label: t.tracer.rowAdd, shortcut: "Insert", scope: "tracer", run: () => editRow("add") },
    { id: "tracerRowInsert", label: t.tracer.rowInsert, shortcut: "Ctrl+Insert", scope: "tracer", enabled: hasCursor, run: () => editRow("insert") },
    { id: "tracerRowEdit", label: t.tracer.rowEdit, shortcut: "Ctrl+Enter", scope: "tracer", enabled: hasCursor, run: () => editRow("edit") },
    {
      id: "tracerRowDelete",
      label: t.tracer.rowDelete,
      shortcut: "Ctrl+Delete",
      scope: "tracer",
      enabled: hasCursor,
      run: () => {
        const pos = cursorPos();
        if (pos != null) void deleteRows([pos]);
      },
    },
    {
      id: "tracerRowsDelete",
      label: t.tracer.rowsDelete,
      scope: "tracer",
      enabled: hasSelection,
      run: async () => {
        const positions = selectedPositions();
        if (positions.length > 1 && !(await confirmDialog(t.tracer.rowsDelete, t.tracer.rowsDeleteAsk(positions.length)))) return;
        void deleteRows(positions);
      },
    },
    {
      id: "tracerRowComment",
      label: t.tracer.rowComment,
      scope: "tracer",
      enabled: hasCursor,
      run: () =>
        cursorRow()
          .then((r) => r && openDialog(<RowCommentDialog row={r} />))
          .catch(toastErr),
    },
    {
      id: "tracerRowsCopy",
      label: t.tracer.rowsCopy,
      shortcut: "Ctrl+C",
      scope: "tracer",
      enabled: () => hasSelection() || hasCursor(),
      run: () => copySelected().catch(toastErr),
    },
    { id: "tracerDisableRow", label: t.tracer.disableRow, scope: "tracer", enabled: hasCursor, run: () => enablePositions([cursorPos()!], false) },
    { id: "tracerEnableRow", label: t.tracer.enableRow, scope: "tracer", enabled: hasCursor, run: () => enablePositions([cursorPos()!], true) },
    { id: "tracerDisableSel", label: t.tracer.disableSelected, scope: "tracer", enabled: hasSelection, run: () => enablePositions(selectedPositions(), false) },
    { id: "tracerEnableSel", label: t.tracer.enableSelected, scope: "tracer", enabled: hasSelection, run: () => enablePositions(selectedPositions(), true) },
    { id: "tracerDisableById", label: t.tracer.disableById, scope: "tracer", enabled: hasCursor, run: () => enableById(false) },
    { id: "tracerEnableById", label: t.tracer.enableById, scope: "tracer", enabled: hasCursor, run: () => enableById(true) },
    {
      id: "tracerStart",
      label: t.tracer.traceStart,
      scope: "tracer",
      enabled: hasCursor,
      checked: () => (hasCursor(), focusedRow()?.start ?? false),
      run: () => setBound("start"),
    },
    {
      id: "tracerFinish",
      label: t.tracer.traceFinish,
      scope: "tracer",
      enabled: hasCursor,
      checked: () => (hasCursor(), focusedRow()?.finish ?? false),
      run: () => setBound("finish"),
    },
    {
      id: "tracerBpList",
      label: t.tracer.breakpoints,
      shortcut: "Ctrl+F5",
      icon: ListOrdered,
      scope: "tracer",
      run: () => openDialog(<BreakpointsDialog />),
    },
    {
      id: "tracerBpClear",
      label: t.tracer.bpClear,
      shortcut: "Shift+F5",
      scope: "tracer",
      enabled: () => store.tracer.value.breakpoints.length > 0,
      run: async () => {
        const n = store.tracer.value.breakpoints.length;
        if (n > 1 && !(await confirmDialog(t.tracer.bpClear, t.tracer.bpClearAsk(n)))) return;
        cmd("tracer_bp_clear").catch(toastErr);
      },
    },
  ];
}

/** Контекстное меню таблицы трейса в порядке pmTrace десктопа. */
export function editMenu(): MenuItem[] {
  return [
    { action: "tracerRowAdd" },
    { action: "tracerRowInsert" },
    { separator: true },
    { action: "tracerRowEdit" },
    { action: "tracerRowDelete" },
    { separator: true },
    { action: "tracerRowsDelete" },
    { action: "tracerRowsCopy" },
    { separator: true },
    { action: "tracerDisableRow" },
    { action: "tracerEnableRow" },
    { action: "tracerDisableSel" },
    { action: "tracerEnableSel" },
    { action: "tracerDisableById" },
    { action: "tracerEnableById" },
    { separator: true },
    { action: "tracerCancelSel" },
    { separator: true },
    { action: "tracerStart" },
    { action: "tracerFinish" },
  ];
}
