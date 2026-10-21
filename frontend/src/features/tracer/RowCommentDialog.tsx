/** «Комментарий строки…»: свой комментарий строки трейса (колонка «Комментарий», в .trc
 * сохраняется со строкой). Пустой — в колонке снова виден комментарий ID. В десктопе
 * поля для него нет: меню «Комментарий» и F4 — комментарии ID. */
import { useState } from "preact/hooks";
import { closeDialog } from "../../app/ui";
import { cmd } from "../../core/client";
import type { TracerRowJson } from "../../core/types";
import { t } from "../../i18n/ru";
import { Dialog } from "../../ui/Dialog";

export function RowCommentDialog({ row, onClose = closeDialog }: { row: TracerRowJson; onClose?: () => void }) {
  const [text, setText] = useState(row.comment);
  const [err, setErr] = useState("");
  const save = () => {
    cmd("tracer_comment", { pos: row.pos, text: text.trim() })
      .then(onClose)
      .catch((e: Error) => setErr(e.message));
  };
  return (
    <Dialog title={t.tracer.rowCommentDialog(row.i + 1)} onClose={onClose} onOk={save} okLabel={t.common.set} width={480}>
      <label class="field stack">
        <span>{t.comment.label}</span>
        <input
          class="inp"
          aria-label={t.comment.label}
          value={text}
          maxLength={200}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
      </label>
      <div class="muted">{t.tracer.rowCommentHint}</div>
      <div class="err-line">{err}</div>
    </Dialog>
  );
}
