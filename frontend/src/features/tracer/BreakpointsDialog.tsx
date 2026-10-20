/** «Точки останова» (Ctrl+F5): список строк с точками останова — номер, время, канал,
 * ID и данные; «Перейти» ставит курсор на строку, «Удалить» снимает точку, «Удалить
 * все» — все. Строки, скрытые фильтром ID, видны в списке, но перейти к ним нельзя. */
import { useEffect, useState } from "preact/hooks";
import { closeDialog } from "../../app/ui";
import { cmd } from "../../core/client";
import { fmtData, fmtId, fmtTime } from "../../core/format";
import { pushToast, store } from "../../core/store";
import type { TracerRowJson } from "../../core/types";
import { t } from "../../i18n/ru";
import { Dialog } from "../../ui/Dialog";
import { tracerGrid, tracerSel, tracerSelVersion } from "./tracerStore";

const toastErr = (e: Error) => pushToast("error", e.message);

export function goToPosition(pos: number): void {
  tracerSel.click(pos);
  tracerSelVersion.value++;
  tracerGrid.ctl?.scrollToRow(pos);
  tracerGrid.ctl?.focus();
}

export function BreakpointsDialog({ onClose = closeDialog }: { onClose?: () => void }) {
  const bps = store.tracer.value.breakpoints;
  const [rows, setRows] = useState<Record<number, TracerRowJson>>({});
  const [sel, setSel] = useState<number | null>(bps.length ? 0 : null);
  const key = bps.map((b) => `${b.i}:${b.pos}`).join(",");

  useEffect(() => {
    let alive = true;
    for (const b of bps) {
      if (b.pos == null) continue;
      cmd<{ rows: TracerRowJson[] }>("tracer_rows", { start: b.pos, count: 1 })
        .then((d) => {
          const r = d.rows?.[0];
          if (alive && r) setRows((prev) => ({ ...prev, [b.i]: r }));
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [key]);

  const cur = sel != null ? bps[sel] : undefined;
  const go = () => {
    if (cur?.pos == null) return;
    onClose();
    goToPosition(cur.pos);
  };

  return (
    <Dialog
      title={t.tracer.bpDialog}
      onClose={onClose}
      width={620}
      footerLeft={
        <span class="inline-row">
          <button type="button" class="btn" disabled={cur?.pos == null} onClick={go}>
            {t.tracer.goTo}
          </button>
          <button
            type="button"
            class="btn"
            disabled={cur?.pos == null}
            onClick={() => cur?.pos != null && cmd("tracer_bp", { pos: cur.pos, on: false }).catch(toastErr)}
          >
            {t.common.remove}
          </button>
          <button type="button" class="btn" disabled={!bps.length} onClick={() => cmd("tracer_bp_clear").catch(toastErr)}>
            {t.tracer.bpClearAll}
          </button>
        </span>
      }
    >
      {bps.length ? (
        <div class="bp-list" role="listbox" aria-label={t.tracer.bpDialog}>
          {bps.map((b, k) => {
            const r = rows[b.i];
            return (
              <div
                role="option"
                aria-selected={k === sel}
                class={"bp-item" + (k === sel ? " sel" : "") + (b.pos == null ? " hidden-row" : "")}
                onClick={() => setSel(k)}
                onDblClick={go}
              >
                <span class="bp-dot" />
                <span class="mono bp-n">{b.i + 1}</span>
                {b.pos == null ? (
                  <span class="muted">{t.tracer.bpHidden}</span>
                ) : r ? (
                  <>
                    <span class="mono">{fmtTime(r.t)}</span>
                    <span class={`ch-tag${r.ch === 2 ? " ch2" : ""}`}>{r.ch}</span>
                    <span class="mono bp-id">{fmtId(r.id, r.ext, true)}</span>
                    <span class="mono">{fmtData(r.data).join(" ")}</span>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div class="muted">{t.tracer.bpEmpty}</div>
      )}
    </Dialog>
  );
}
