/** Диалоги монитора: «Изменить комментарий для <ID>» и «Период изменения редких данных». */
import { useState } from "preact/hooks";
import { closeDialog } from "../../app/ui";
import { cmd } from "../../core/client";
import { fmtId, parseIntRange } from "../../core/format";
import { commentKey, store } from "../../core/store";
import { t } from "../../i18n/ru";
import { Dialog } from "../../ui/Dialog";

export function CommentDialog({ id, ext }: { id: number; ext: boolean }) {
  const [text, setText] = useState(store.comments.value[commentKey(id, ext)] ?? "");
  const [err, setErr] = useState("");
  const save = () => {
    cmd("comment_set", { id, ext, text })
      .then(closeDialog)
      .catch((e: Error) => setErr(e.message));
  };
  return (
    <Dialog title={t.comment.dialog(fmtId(id, ext, store.settings.value.monitor_hex_ids))} onClose={closeDialog} onOk={save} okLabel={t.common.set} width={480}>
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
      <div class="err-line">{err}</div>
    </Dialog>
  );
}

export function RarePeriodDialog() {
  const [value, setValue] = useState(String(store.settings.value.rare_period_ms));
  const [err, setErr] = useState("");
  const save = () => {
    try {
      const ms = parseIntRange(value, 100, 10000, t.rare.label);
      cmd("settings_set", { patch: { rare_period_ms: ms, rare_mode: true } })
        .then(closeDialog)
        .catch((e: Error) => setErr(e.message));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Dialog title={t.rare.dialog} onClose={closeDialog} onOk={save} okLabel={t.common.set} width={420}>
      <label class="field">
        <span>{t.rare.label}</span>
        <input
          class={"inp mono" + (err ? " invalid" : "")}
          style={{ width: "90px" }}
          aria-label={t.rare.label}
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
        <span>{t.common.ms}</span>
      </label>
      <div class="err-line">{err}</div>
    </Dialog>
  );
}
