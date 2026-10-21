/** Действия монитора (тулбар, контекстное меню, хоткеи) — названия и хоткеи десктопа. */
import { Columns2, Eraser, Grid3x3, Layers, MessageSquare, Timer } from "lucide-preact";
import { openDialog, ui } from "../../app/ui";
import { registerActions, type Action } from "../../core/actions";
import { cmd } from "../../core/client";
import { fmtAscii, fmtData, fmtFlags, fmtId, fmtPeriod } from "../../core/format";
import { commentKey, pushToast, store } from "../../core/store";
import type { MonitorRowJson, Settings } from "../../core/types";
import { t } from "../../i18n/ru";
import { confirmDialog } from "../../ui/confirm";
import { streamSelection } from "../stream/StreamGrid";
import { openBitmap, openStreamBitmap } from "./BitmapWindow";
import { CommentDialog, RarePeriodDialog } from "./dialogs";
import { focusedFramesMessage, openFrames } from "./FramesWindow";
import { monitorSelection, monitorStore } from "./MonitorGrid";

const toastErr = (e: Error) => pushToast("error", e.message);

function setSetting(patch: Partial<Settings>): void {
  cmd("settings_set", { patch }).catch(toastErr);
}

/** Снимок таблицы монитора в текст (TAB-разделитель) — «Сохранить RX-List». */
export function rxListText(rows: MonitorRowJson[], hex: boolean, comments: Record<string, string>, aggregator = false): string {
  const fc = aggregator ? [t.col.fc] : [];
  const head = [t.col.ch, t.col.flags, t.col.id, t.col.dlc, t.col.data, t.col.period, t.col.count, ...fc, t.col.ascii, t.col.comment];
  const lines = rows.map((r) =>
    [r.ch, fmtFlags(r), fmtId(r.id, r.ext, hex), r.dlc, fmtData(r.data).join(" "), fmtPeriod(r.period_ms), r.count,
      ...(aggregator ? [r.fc] : []), fmtAscii(r.data), comments[commentKey(r.id, r.ext)] ?? ""].join("\t"),
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
  /** Сообщение для F3 / Ctrl+F3 / F4 и «Добавить ID в фильтр»: в режиме «Поток» — выделенная
   * строка потока (как у Ctrl+↓), а не невидимое там выделение монитора. */
  const sel = (): { ch: number; id: number; ext: boolean } | null =>
    ui.receiveMode.value === "stream" ? streamSelection.value : monitorSelection.value;
  const s = () => store.settings.value;
  return [
    {
      id: "clear",
      label: t.hint.clear,
      shortcut: "Ctrl+N",
      icon: Eraser,
      scope: "main",
      run: async () => {
        if (ui.receiveMode.value !== "stream") return void cmd("monitor_clear").catch(toastErr);
        // несохранённый поток (с метками) стирается безвозвратно — спросить, как отладчик
        const c = store.capture.value;
        if (c.dirty && c.count > 0 && !(await confirmDialog(t.hint.clear, t.stream.clearAsk(c.count, c.markers.length)))) return;
        cmd("capture_clear").catch(toastErr);
      },
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
        if (ui.receiveMode.value === "stream") return openStreamBitmap();     // идёт за выделением потока
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
        if (r) openFrames(r.ch, r.id, r.ext, ui.receiveMode.value === "stream" ? "stream" : "monitor");
      },
    },
    {
      id: "comment",
      label: t.rxMenu.comment,
      hint: t.hint.comment,
      shortcut: "F4",
      icon: MessageSquare,
      scope: "main",
      // F4 в окне «Данные сообщения» — комментарий его сообщения (как у десктопа)
      enabled: () => focusedFramesMessage() != null || sel() != null,
      run: () => {
        const r = focusedFramesMessage() ?? sel();
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
        downloadText(`rx-list_${stamp()}.txt`, rxListText(monitorStore.all(), s().monitor_hex_ids, store.comments.value, s().aggregator)),
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
          .then(() => pushToast("info", t.filters.idAdded(fmtId(r.id, r.ext, s().monitor_hex_ids), r.ch)))
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
    {
      id: "commentsClear",
      label: t.comment.clear,
      scope: "main",
      enabled: () => Object.keys(store.comments.value).length > 0,
      run: async () => {
        const n = Object.keys(store.comments.value).length;
        if (n && (await confirmDialog(t.comment.clear, t.comment.clearAsk(n)))) cmd("comments_clear").catch(toastErr);
      },
    },
  ];
}

export function registerMonitorActions(): () => void {
  return registerActions(monitorActions());
}
