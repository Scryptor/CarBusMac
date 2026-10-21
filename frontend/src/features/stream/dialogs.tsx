/** Диалоги потока: «Установить точку останова / метку» и «Список точек останова / меток». */
import { useState } from "preact/hooks";
import { closeDialog } from "../../app/ui";
import { cmd } from "../../core/client";
import { pushToast, store } from "../../core/store";
import { t } from "../../i18n/ru";
import { Dialog } from "../../ui/Dialog";
import { scrollStreamTo } from "./StreamGrid";

export function MarkerDialog() {
  const [label, setLabel] = useState("");
  const [comment, setComment] = useState("");
  const save = () =>
    cmd("capture_marker", { label, comment, auto: false })
      .then(closeDialog)
      .catch((e: Error) => pushToast("error", e.message));
  return (
    <Dialog title={t.stream.markerDialog} onClose={closeDialog} onOk={save} okLabel={t.common.set} width={460}>
      <div class="form-grid">
        <label for="mk-label">{t.stream.markerLabel}</label>
        <input id="mk-label" class="inp" value={label} maxLength={60} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
        <label for="mk-comment">{t.stream.markerComment}</label>
        <input id="mk-comment" class="inp" value={comment} maxLength={200} onInput={(e) => setComment((e.target as HTMLInputElement).value)} />
      </div>
      <p class="muted" style={{ margin: 0 }}>
        {t.stream.markerHint}
      </p>
    </Dialog>
  );
}

export function MarkersDialog() {
  const markers = store.capture.value.markers;
  const [sel, setSel] = useState<number | null>(markers.length ? 0 : null);
  const go = () => {
    if (sel == null) return;
    scrollStreamTo(markers[sel].index);
    closeDialog();
  };
  return (
    <Dialog title={t.stream.markersDialog} onClose={closeDialog} onOk={go} okLabel={t.stream.goTo} okDisabled={sel == null} width={520}>
      <div class="file-list" role="listbox" aria-label={t.stream.markersDialog}>
        <div class="file-row head">
          <span>{t.col.label}</span>
          <span>{t.stream.row}</span>
          <span>{t.col.comment}</span>
        </div>
        {markers.length === 0 ? <div class="file-empty muted">{t.stream.noMarkers}</div> : null}
        {markers.map((m, i) => (
          <div
            class={"file-row" + (sel === i ? " sel" : "")}
            role="option"
            aria-selected={sel === i}
            onClick={() => setSel(i)}
            onDblClick={go}
          >
            <span class="fname">{m.label}</span>
            <span class="mono">{m.index + 1}</span>
            <span class="fname">{m.comment}</span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
