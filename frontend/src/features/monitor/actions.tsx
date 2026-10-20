/** Действия монитора (тулбар, контекстное меню, хоткеи) — названия и хоткеи десктопа. */
import { Columns2, Eraser, Grid3x3, Layers, MessageSquare, Timer } from "lucide-preact";
import { openDialog, ui } from "../../app/ui";
import { registerActions, type Action } from "../../core/actions";
import { cmd } from "../../core/client";
import { fmtAscii, fmtData, fmtFlags, fmtId, fmtPeriod } from "../../core/format";
import { commentKey, pushToast, store } from "../../core/store";
import type { MonitorRowJson, Settings } from "../../core/types";
import { t } from "../../i18n/ru";
import { openBitmap } from "./BitmapWindow";
import { CommentDialog, RarePeriodDialog } from "./dialogs";
import { openFrames } from "./FramesWindow";
import { monitorSelection, monitorStore } from "./MonitorGrid";

const toastErr = (e: Error) => pushToast("error", e.message);

function setSetting(patch: Partial<Settings>): void {
  cmd("settings_set", { patch }).catch(toastErr);
}

/** Снимок таблицы монитора в текст (TAB-разделитель) — «Сохранить RX-List». */
export function rxListText(rows: MonitorRowJson[], hex: boolean, comments: Record<string, string>): string {
  const head = [t.col.ch, t.col.flags, t.col.id, t.col.dlc, t.col.data, t.col.period, t.col.count, t.col.ascii, t.col.comment];
  const lines = rows.map((r) =>
    [r.ch, fmtFlags(r), fmtId(r.id, r.ext, hex), r.dlc, fmtData(r.data).join(" "), fmtPeriod(r.period_ms), r.count,
      fmtAscii(r.data), comments[commentKey(r.id, r.ext)] ?? ""].join("\t"),
  );
  return [head.join("\t"), ...lines].join("\n") + "\n";
}

export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function monitorActions(): Action[] {
  const sel = () => monitorSelection.value;
  const s = () => store.settings.value;
  return [
    {
      id: "clear",
      label: t.hint.clear,
      shortcut: "Ctrl+N",
      icon: Eraser,
      scope: "main",
      run: () => cmd(ui.receiveMode.value === "stream" ? "capture_clear" : "monitor_clear").catch(toastErr),
    },
    {
      id: "bitmap",
      label: t.rxMenu.bitmap,
      hint: t.hint.bitmap,
      shortcut: "F3",
      icon: Grid3x3,
      scope: "main",
      enabled: () => sel() != null,
      run: () => {
        const r = sel();
        if (r) openBitmap(r.ch, r.id, r.ext);
      },
    },
    {
      id: "frames",
      label: t.rxMenu.frames,
      hint: t.hint.frames,
      shortcut: "Ctrl+F3",
      icon: Layers,
      scope: "main",
      enabled: () => sel() != null,
      run: () => {
        const r = sel();
        if (r) openFrames(r.ch, r.id, r.ext);
      },
    },
    {
      id: "comment",
      label: t.rxMenu.comment,
      hint: t.hint.comment,
      shortcut: "F4",
      icon: MessageSquare,
      scope: "main",
      enabled: () => sel() != null,
      run: () => {
        const r = sel();
        if (r) openDialog(<CommentDialog id={r.id} ext={r.ext} />);
      },
    },
    {
      id: "rareMode",
      label: t.rare.highlight,
      hint: t.hint.rare,
      icon: Timer,
      scope: "main",
      checked: () => s().rare_mode,
      run: () => setSetting({ rare_mode: !s().rare_mode }),
    },
    { id: "rarePeriod", label: `${t.rare.setPeriod}…`, scope: "main", run: () => openDialog(<RarePeriodDialog />) },
    {
      id: "hexIds",
      label: t.rxMenu.hexIds,
      scope: "main",
      checked: () => s().monitor_hex_ids,
      run: () => setSetting({ monitor_hex_ids: !s().monitor_hex_ids }),
    },
    {
      id: "sort",
      label: t.rxMenu.sort,
      scope: "main",
      checked: () => s().monitor_sort,
      run: () => setSetting({ monitor_sort: !s().monitor_sort }),
    },
    {
      id: "groupByChannel",
      label: t.rxMenu.group,
      scope: "main",
      checked: () => s().monitor_group_by_channel,
      run: () => setSetting({ monitor_group_by_channel: !s().monitor_group_by_channel }),
    },
    {
      id: "saveRxList",
      label: t.rxMenu.saveRxList,
      scope: "main",
      enabled: () => monitorStore.size > 0,
      run: () =>
        downloadText(`rx-list_${stamp()}.txt`, rxListText(monitorStore.all(), s().monitor_hex_ids, store.comments.value)),
    },
    {
      id: "addIdToFilter",
      label: t.rxMenu.addToFilter,
      scope: "main",
      enabled: () => sel() != null,
      run: () => {
        const r = sel();
        if (!r) return;
        cmd("filters_add_id", { channel: r.ch, id: r.id, ext: r.ext })
          .then(() => pushToast("info", t.filters.idAdded(fmtId(r.id, r.ext, true), r.ch)))
          .catch(toastErr);
      },
    },
    {
      id: "split",
      label: t.receive.separate,
      hint: t.hint.split,
      icon: Columns2,
      scope: "main",
      checked: () => ui.split.value,
      run: () => {
        ui.receiveMode.value = "monitor";
        ui.split.value = !ui.split.value;
      },
    },
    { id: "commentsClear", label: t.comment.clear, scope: "main", run: () => cmd("comments_clear").catch(toastErr) },
  ];
}

export function registerMonitorActions(): () => void {
  return registerActions(monitorActions());
}
