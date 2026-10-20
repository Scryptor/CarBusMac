/** Действия передачи: контекстное меню списка, «Копировать в TX-List» (Ctrl+↓) из
 * монитора, потока и окна «Данные сообщения», загрузка/сохранение списка (.tsk/.json). */
import { ArrowDownToLine } from "lucide-preact";
import { closeDialog, openDialog, ui } from "../../app/ui";
import { registerActions, type Action } from "../../core/actions";
import { cmd } from "../../core/client";
import { commentKey, pushToast, store } from "../../core/store";
import { t } from "../../i18n/ru";
import { confirmDialog } from "../../ui/confirm";
import { FileDialog } from "../files/FileDialog";
import { framesPick } from "../monitor/FramesWindow";
import { monitorSelection } from "../monitor/MonitorGrid";
import { streamSelection } from "../stream/StreamGrid";
import { slots } from "../../app/Workspace";
import { selectedTask, TransmitDock, txApi, txSelected } from "./TransmitDock";
import { nextTaskId, taskFromRow } from "./txModel";

const toastErr = (e: Error) => pushToast("error", e.message);
const has = () => selectedTask() != null;
const any = () => store.tasks.value.length > 0;

/** Создать задачу из принятого сообщения, выделить её и показать док передачи. */
export function copyRowToTx(row: { ch: number; id: number; ext: boolean; rtr: boolean; data: string }): void {
  const id = nextTaskId(store.tasks.value);
  const task = taskFromRow(row, id, store.comments.value[commentKey(row.id, row.ext)] ?? "");
  cmd("tx_upsert", { task })
    .then(() => {
      txSelected.value = id;
      ui.dockOpen.value = true;
    })
    .catch(toastErr);
}

function stampName(prefix: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${prefix} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function transmitActions(): Action[] {
  return [
    {
      id: "copyToTx",
      label: t.rxMenu.copyToTx,
      hint: t.hint.copyToTx,
      shortcut: "Ctrl+ArrowDown",
      icon: ArrowDownToLine,
      scope: "main",
      enabled: () => (ui.receiveMode.value === "stream" ? streamSelection.value : monitorSelection.value) != null,
      run: () => {
        const r = ui.receiveMode.value === "stream" ? streamSelection.value : monitorSelection.value;
        if (r) copyRowToTx({ ch: r.ch, id: r.id, ext: r.ext, rtr: r.rtr, data: r.data });
      },
    },
    {
      id: "copyStreamToTx",
      label: t.rxMenu.copyToTx,
      scope: "main",
      enabled: () => streamSelection.value != null,
      run: () => {
        const r = streamSelection.value;
        if (r) copyRowToTx({ ch: r.ch, id: r.id, ext: r.ext, rtr: r.rtr, data: r.data });
      },
    },
    {
      id: "copyFrameToTx",
      label: t.rxMenu.copyToTx,
      scope: "global",
      enabled: () => framesPick.current != null,
      run: () => {
        const p = framesPick.current;
        if (p) copyRowToTx({ ch: p.ch, id: p.id, ext: p.ext, rtr: false, data: p.data });
      },
    },
    { id: "txAdd", label: t.tx.add, scope: "main", run: () => txApi.add?.() },
    { id: "txCopy", label: t.tx.copy, scope: "main", enabled: has, run: () => txApi.copy?.() },
    { id: "txDelete", label: t.tx.del, scope: "main", enabled: has, run: () => txApi.del?.() },
    {
      id: "txClear",
      label: t.tx.clearList,
      scope: "main",
      enabled: any,
      run: async () => {
        if (await confirmDialog(t.tx.clearList, t.tx.confirmClear)) cmd("tx_clear").catch(toastErr);
      },
    },
    { id: "txSingle", label: t.tx.single, scope: "main", enabled: has, run: () => txApi.send?.() },
    { id: "txRunPause", label: t.tx.startPause, shortcut: "Pause", scope: "main", enabled: has, run: () => txApi.runPause?.() },
    { id: "txRunAll", label: t.tx.runAll, scope: "main", enabled: any, run: () => cmd("tx_start_all").catch(toastErr) },
    { id: "txStopAll", label: t.tx.stopAll, scope: "main", enabled: any, run: () => cmd("tx_pause_all").catch(toastErr) },
    {
      id: "txReset",
      label: t.tx.resetCounter,
      scope: "main",
      enabled: has,
      run: () => cmd("tx_reset", { id: txSelected.value }).catch(toastErr),
    },
    { id: "txResetAll", label: t.tx.resetAll, scope: "main", enabled: any, run: () => cmd("tx_reset", { id: null }).catch(toastErr) },
    {
      id: "txLoad",
      label: t.tx.load,
      scope: "main",
      run: () =>
        openDialog(
          <FileDialog
            mode="open"
            kind="lists"
            title={t.menu.loadTx}
            extensions={[".tsk", ".json"]}
            onClose={closeDialog}
            onPick={(name) => {
              closeDialog();
              cmd<{ count: number }>("tx_load", { name })
                .then((d) => {
                  txSelected.value = null;
                  ui.dockOpen.value = true;
                  pushToast("info", `Загружено задач: ${d.count}`);
                })
                .catch(toastErr);
            }}
          />,
        ),
    },
    {
      id: "txSave",
      label: t.tx.save,
      scope: "main",
      enabled: any,
      run: () =>
        openDialog(
          <FileDialog
            mode="save"
            kind="lists"
            title={t.menu.saveTx}
            defaultName={stampName("transmit")}
            extensions={[".tsk", ".json"]}
            formats={[
              { value: "tsk", label: "CarBUS Analyzer (.tsk)" },
              { value: "json", label: "JSON (.json)" },
            ]}
            onClose={closeDialog}
            onPick={(name, format) => {
              closeDialog();
              cmd("tx_save", { name, format }).catch(toastErr);
            }}
          />,
        ),
    },
  ];
}

export function registerTransmit(): void {
  registerActions(transmitActions());
  slots.transmit = () => <TransmitDock />;
}
