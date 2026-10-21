/** Действия потока и файлов: запись (F5), метки (F8 / авто F9), список меток, загрузка и
 * сохранение трейса, перенос в отладчик (Ctrl+F12), файлы комментариев. */
import { ArrowRightToLine, Bookmark, Circle, FolderOpen, List, Save } from "lucide-preact";
import { closeDialog, openDialog, ui } from "../../app/ui";
import { registerActions, type Action } from "../../core/actions";
import { cmd } from "../../core/client";
import { pushToast, store } from "../../core/store";
import { t } from "../../i18n/ru";
import { confirmDialog } from "../../ui/confirm";
import { FileDialog } from "../files/FileDialog";
import { canDiscard } from "../tracer/actions";
import { MarkerDialog, MarkersDialog } from "./dialogs";

const toastErr = (e: Error) => pushToast("error", e.message);
const cap = () => store.capture.value;

function stampName(prefix: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${prefix} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}

export function openTraceFile(onPick: (name: string) => void): void {
  openDialog(
    <FileDialog
      mode="open"
      kind="traces"
      title={t.hint.loadStream}
      onClose={closeDialog}
      onPick={(name) => {
        closeDialog();
        onPick(name);
      }}
    />,
  );
}

export function streamActions(): Action[] {
  return [
    {
      id: "record",
      label: t.stream.recording,
      hint: t.hint.record,
      shortcut: "F5",
      icon: Circle,
      scope: "main",
      checked: () => cap().recording,
      enabled: () => !cap().full,
      run: () => cmd("capture_record", { on: !cap().recording }).catch(toastErr),
    },
    {
      id: "marker",
      label: t.stream.markerDialog,
      hint: t.hint.marker,
      shortcut: "F8",
      icon: Bookmark,
      scope: "main",
      enabled: () => cap().recording,
      run: () => openDialog(<MarkerDialog />),
    },
    {
      id: "autoMarker",
      label: t.stream.autoMarker,
      shortcut: "F9",
      scope: "main",
      enabled: () => cap().recording,
      run: () =>
        cmd<{ label: string }>("capture_marker", { label: "", comment: "", auto: true })
          .then((d) => pushToast("info", t.stream.markerAdded(d.label)))
          .catch(toastErr),
    },
    {
      id: "markers",
      label: t.stream.markersDialog,
      hint: t.hint.markers,
      icon: List,
      scope: "main",
      enabled: () => cap().markers.length > 0,
      run: () => openDialog(<MarkersDialog />),
    },
    {
      id: "loadStream",
      label: t.hint.loadStream,
      icon: FolderOpen,
      scope: "main",
      run: () =>
        openTraceFile((name) =>
          cmd<{ count: number; skipped: number }>("capture_load", { name })
            .then((d) => {
              ui.view.value = "main";
              ui.receiveMode.value = "stream";
              pushToast("info", t.stream.loaded(d.count, d.skipped));
            })
            .catch(toastErr),
        ),
    },
    {
      id: "saveStream",
      label: t.hint.saveStream,
      icon: Save,
      scope: "main",
      enabled: () => cap().count > 0,
      run: () =>
        openDialog(
          <FileDialog
            mode="save"
            kind="traces"
            title={t.hint.saveStream}
            defaultName={stampName("trace")}
            withFormat
            onClose={closeDialog}
            onPick={(name, format) => {
              closeDialog();
              cmd("capture_save", { name, format }).catch(toastErr);
            }}
          />,
        ),
    },
    {
      id: "toTracer",
      label: t.hint.toTracer,
      shortcut: "Ctrl+F12",
      icon: ArrowRightToLine,
      scope: "main",
      enabled: () => cap().count > 0,
      run: async () => {
        // поток заменит трейс в отладчике — изменённый несохранённый не теряем молча
        if (!(await canDiscard(t.hint.toTracer))) return;
        cmd("capture_to_tracer")
          .then(() => (ui.view.value = "tracer"))
          .catch(toastErr);
      },
    },
    {
      id: "commentsLoad",
      label: t.comment.open,
      scope: "main",
      run: () =>
        openDialog(
          <FileDialog
            mode="open"
            kind="lists"
            title={t.comment.open}
            extensions={[".cmt", ".json"]}
            onClose={closeDialog}
            onPick={async (name) => {
              closeDialog();
              const append =
                Object.keys(store.comments.value).length > 0 &&
                (await confirmDialog(t.menu.loadComments, t.comment.appendAsk));
              cmd("comments_load", { name, append }).catch(toastErr);
            }}
          />,
        ),
    },
    {
      id: "commentsSave",
      label: t.comment.save,
      scope: "main",
      enabled: () => Object.keys(store.comments.value).length > 0,
      run: () =>
        openDialog(
          <FileDialog
            mode="save"
            kind="lists"
            title={t.comment.save}
            defaultName={stampName("comments")}
            extensions={[".cmt", ".json"]}
            formats={[
              { value: "cmt", label: "CarBUS Analyzer (.cmt)" },
              { value: "json", label: "JSON (.json)" },
            ]}
            onClose={closeDialog}
            onPick={(name, format) => {
              closeDialog();
              cmd("comments_save", { name, format }).catch(toastErr);
            }}
          />,
        ),
    },
  ];
}

export function registerStreamActions(): () => void {
  return registerActions(streamActions());
}
