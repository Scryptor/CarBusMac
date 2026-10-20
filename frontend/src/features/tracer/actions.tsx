/** Действия отладчика (вид F12) — как TActionList окна «Отладчик» десктопа и с его
 * хоткеями: файл трейса, комментарий, таблица ID, воспроизведение, точка останова. */
import {
  ArrowDownToLine,
  CircleDot,
  FilePlus2,
  FolderOpen,
  ListChecks,
  ListFilter,
  MessageSquare,
  Pause,
  Play,
  Repeat,
  Save,
  Square,
  StepForward,
} from "lucide-preact";
import { closeDialog, openDialog, ui } from "../../app/ui";
import type { Action } from "../../core/actions";
import { cmd } from "../../core/client";
import { pushToast, store } from "../../core/store";
import { t } from "../../i18n/ru";
import { confirmDialog } from "../../ui/confirm";
import type { MenuItem } from "../../ui/Menu";
import { FileDialog } from "../files/FileDialog";
import { CommentDialog } from "../monitor/dialogs";
import { copyRowToTx } from "../transmit/actions";
import { setPlayer } from "./DelayMenu";
import { cursorRow, hasCursor, selectionPayload, tracerSel } from "./tracerStore";

const tr = () => store.tracer.value;
const toastErr = (e: Error) => pushToast("error", e.message);

async function canDiscard(title: string): Promise<boolean> {
  return !tr().modified || confirmDialog(title, t.tracer.discard);
}

export function rememberRecent(name: string): void {
  ui.tracerRecent.value = [name, ...ui.tracerRecent.value.filter((n) => n !== name)].slice(0, 10);
}

export function openTrace(name: string): void {
  cmd<{ count: number; skipped: number }>("tracer_open", { name })
    .then((d) => {
      rememberRecent(name);
      ui.view.value = "tracer";
      pushToast("info", t.tracer.loaded(d.count, d.skipped));
    })
    .catch(toastErr);
}

function saveTrace(name: string, format: string): void {
  cmd<{ name: string }>("tracer_save", { name, format })
    .then((d) => {
      rememberRecent(d.name);
      pushToast("info", t.tracer.saved(d.name));
    })
    .catch(toastErr);
}

function saveAs(): void {
  const cur = tr().name;
  openDialog(
    <FileDialog
      mode="save"
      kind="traces"
      title={t.tracer.saveAs}
      defaultName={cur ? cur.replace(/\.(trc|jsonl)$/i, "") : "trace"}
      withFormat
      onClose={closeDialog}
      onPick={(name, format) => {
        closeDialog();
        saveTrace(name, format ?? "trc");
      }}
    />,
  );
}

export function recentItems(): MenuItem[] {
  const list = ui.tracerRecent.value;
  if (!list.length) return [{ label: t.tracer.recentEmpty, disabled: true, run: () => {} }];
  return list.map((name) => ({
    label: name,
    run: async () => {
      if (await canDiscard(t.tracer.open)) openTrace(name);
    },
  }));
}

/** Иконка кнопки «Запуск/пауза» меняется вместе с состоянием проигрывателя. */
function PlayPauseIcon(props: { size?: number | string; strokeWidth?: number | string }) {
  return tr().state === "playing" ? <Pause {...props} /> : <Play {...props} />;
}

export function tracerActions(): Action[] {
  return [
    {
      id: "tracerNew",
      label: t.tracer.newTrace,
      hint: t.tracer.newHint,
      shortcut: "Ctrl+N",
      icon: FilePlus2,
      scope: "tracer",
      run: async () => {
        if (await canDiscard(t.tracer.newTrace)) cmd("tracer_new").catch(toastErr);
      },
    },
    {
      id: "tracerOpen",
      label: t.tracer.open,
      hint: t.tracer.openHint,
      shortcut: "Ctrl+O",
      icon: FolderOpen,
      scope: "tracer",
      run: async () => {
        if (!(await canDiscard(t.tracer.open))) return;
        openDialog(
          <FileDialog
            mode="open"
            kind="traces"
            title={t.tracer.openHint}
            onClose={closeDialog}
            onPick={(name) => {
              closeDialog();
              openTrace(name);
            }}
          />,
        );
      },
    },
    {
      id: "tracerSave",
      label: t.tracer.save,
      shortcut: "Ctrl+S",
      icon: Save,
      scope: "tracer",
      enabled: () => tr().count > 0,
      run: () => {
        const name = tr().name;
        if (name) saveTrace(name, name.toLowerCase().endsWith(".jsonl") ? "jsonl" : "trc");
        else saveAs();
      },
    },
    {
      id: "tracerSaveAs",
      label: t.tracer.saveAs,
      shortcut: "Ctrl+Shift+S",
      scope: "tracer",
      enabled: () => tr().count > 0,
      run: saveAs,
    },
    {
      id: "tracerComment",
      label: t.tracer.commentEdit,
      hint: t.tracer.commentHint,
      shortcut: "F4",
      icon: MessageSquare,
      scope: "tracer",
      enabled: hasCursor,
      run: () =>
        cursorRow()
          .then((r) => r && openDialog(<CommentDialog id={r.id} ext={r.ext} />))
          .catch(toastErr),
    },
    {
      id: "tracerIds",
      label: t.tracer.idTable,
      shortcut: "Ctrl+F3",
      icon: ListFilter,
      scope: "tracer",
      checked: () => ui.tracerIdsOpen.value,
      run: () => {
        ui.tracerIdsOpen.value = !ui.tracerIdsOpen.value;
      },
    },
    {
      id: "tracerPlay",
      label: t.tracer.play,
      shortcut: "F9",
      icon: PlayPauseIcon,
      scope: "tracer",
      enabled: () => tr().visible > 0,
      checked: () => tr().state === "playing",
      run: () =>
        (tr().state === "playing"
          ? cmd("tracer_pause")
          : cmd("tracer_play", { selection: selectionPayload(tracerSel, ui.tracerPlaySelected.value) })
        ).catch(toastErr),
    },
    {
      id: "tracerStop",
      label: t.tracer.stop,
      icon: Square,
      scope: "tracer",
      enabled: () => tr().state !== "stopped",
      run: () => cmd("tracer_stop").catch(toastErr),
    },
    {
      id: "tracerStep",
      label: t.tracer.step,
      shortcut: "F8",
      icon: StepForward,
      scope: "tracer",
      enabled: () => tr().visible > 0 && tr().state !== "playing",
      run: () => cmd("tracer_step").catch(toastErr),
    },
    {
      id: "tracerLoop",
      label: t.tracer.loop,
      icon: Repeat,
      scope: "tracer",
      checked: () => tr().config.loop,
      run: () => setPlayer({ loop: !tr().config.loop }),
    },
    {
      id: "tracerPlaySel",
      label: t.tracer.playSelected,
      icon: ListChecks,
      scope: "tracer",
      checked: () => ui.tracerPlaySelected.value,
      run: () => {
        ui.tracerPlaySelected.value = !ui.tracerPlaySelected.value;
      },
    },
    {
      id: "tracerCopyTx",
      label: t.tracer.copyToTx,
      icon: ArrowDownToLine,
      scope: "tracer",
      enabled: hasCursor,
      run: () =>
        cursorRow()
          .then((r) => r && copyRowToTx(r))
          .catch(toastErr),
    },
    {
      id: "tracerBp",
      label: t.tracer.breakpoint,
      shortcut: "F5",
      icon: CircleDot,
      scope: "tracer",
      enabled: hasCursor,
      run: () => {
        if (tracerSel.focus != null) cmd("tracer_bp", { pos: tracerSel.focus }).catch(toastErr);
      },
    },
  ];
}
