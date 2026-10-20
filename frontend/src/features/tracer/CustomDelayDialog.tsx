/** «Пользовательская пауза»: фиксированная пауза между сообщениями, 10–9999 мс. */
import { useState } from "preact/hooks";
import { closeDialog } from "../../app/ui";
import { cmd } from "../../core/client";
import { parseIntRange } from "../../core/format";
import { store } from "../../core/store";
import { t } from "../../i18n/ru";
import { Dialog } from "../../ui/Dialog";

export function CustomDelayDialog() {
  const [value, setValue] = useState(String(store.tracer.value.config.fixed_ms || 100));
  const [err, setErr] = useState("");
  const save = () => {
    try {
      const ms = parseIntRange(value, 10, 9999, t.tracer.customLabel);
      cmd("tracer_config", { patch: { delay_mode: "fixed", fixed_ms: ms } })
        .then(closeDialog)
        .catch((e: Error) => setErr(e.message));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Dialog title={t.tracer.customDialog} onClose={closeDialog} onOk={save} okLabel={t.common.set} width={360}>
      <div class="form-grid">
        <label for="tr-delay">{t.tracer.customLabel}</label>
        <span class="inline-row">
          <input
            id="tr-delay"
            class="inp mono"
            style={{ width: "90px" }}
            inputMode="numeric"
            value={value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          />
          <span class="muted">{t.common.ms}</span>
        </span>
      </div>
      <div class="err-line">{err}</div>
    </Dialog>
  );
}
