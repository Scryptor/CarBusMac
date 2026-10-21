/** «Добавить / Вставить / Отредактировать строку» отладчика (TdlgTracerRow десктопа без
 * DBC и LIN), группы в его порядке: сообщение (канал, ID, 29 bit, DLC), флаги (RTR),
 * опции — паузы перед и после отправки строки (0–1000 мс), «Значение» + «Заполнить», —
 * и сырые данные. */
import { useState } from "preact/hooks";
import { closeDialog } from "../../app/ui";
import { cmd } from "../../core/client";
import { bytesToHex, fmtId, hexToBytes, parseHexByte, parseHexId, parseIntRange } from "../../core/format";
import type { TracerRowJson } from "../../core/types";
import { t } from "../../i18n/ru";
import { Dialog } from "../../ui/Dialog";
import { ByteCells, Check } from "../../ui/Fields";
import { placeCursorAfter, type CursorReply } from "./tracerStore";

export interface RowDraftJson {
  ch: number;
  id: number;
  ext: boolean;
  rtr: boolean;
  data: string;
  before_ms: number;
  after_ms: number;
}

export type RowEditorMode = "add" | "insert" | "edit";

const TITLES: Record<RowEditorMode, string> = {
  add: t.tracer.rowDialogAdd,
  insert: t.tracer.rowDialogInsert,
  edit: t.tracer.rowDialogEdit,
};

function cellsOf(hex: string): (number | null)[] {
  const b = hexToBytes(hex);
  return Array.from({ length: 8 }, (_, i) => b[i] ?? 0);
}

export function RowEditorDialog({ mode, base, onSubmit, onClose = closeDialog }: {
  mode: RowEditorMode;
  /** правка — сама строка; добавление/вставка — строка под курсором как образец */
  base: TracerRowJson | null;
  /** по умолчанию отправляет команду на сервер */
  onSubmit?: (row: RowDraftJson) => void;
  onClose?: () => void;
}) {
  const [ch, setCh] = useState(String(base?.ch ?? 1));
  const [ext, setExt] = useState(base?.ext ?? false);
  const [id, setId] = useState(base ? fmtId(base.id, base.ext, true) : "000");
  const [dlc, setDlc] = useState(base?.dlc ?? 8);
  const [bytes, setBytes] = useState<(number | null)[]>(cellsOf(base?.data ?? ""));
  const [rtr, setRtr] = useState(base?.rtr ?? false);
  const [before, setBefore] = useState(String(mode === "edit" ? base?.before_ms ?? 0 : 0));
  const [after, setAfter] = useState(String(mode === "edit" ? base?.after_ms ?? 0 : 0));
  const [value, setValue] = useState("00");
  const [err, setErr] = useState("");

  const fill = () => {
    try {
      const v = parseHexByte(value) as number;
      setBytes(bytes.map((b, i) => (i < dlc ? v : b)));
      setErr("");
    } catch (e) {
      setErr(`${t.tx.value}: ${(e as Error).message}`);
    }
  };

  const save = () => {
    let row: RowDraftJson;
    try {
      row = {
        ch: Number(ch),
        id: parseHexId(id, ext),
        ext,
        rtr,
        data: bytesToHex(bytes.slice(0, dlc).map((b) => b ?? 0)),
        before_ms: parseIntRange(before, 0, 1000, t.tracer.beforeLabel),
        after_ms: parseIntRange(after, 0, 1000, t.tracer.afterLabel),
      };
    } catch (e) {
      setErr((e as Error).message);
      return;
    }
    if (onSubmit) {
      onSubmit(row);
      return;
    }
    const sent =
      mode === "edit"
        ? cmd<CursorReply>("tracer_row_edit", { pos: base!.pos, row })
        : mode === "insert" && base
          ? cmd<CursorReply>("tracer_row_add", { row, after: base.pos })
          : cmd<CursorReply>("tracer_row_add", { row });
    sent
      .then((d) => {
        onClose();
        // курсор — на вставленную строку; если она (или правленная) ушла под фильтр ID,
        // сервер называет соседнюю
        placeCursorAfter(d?.rev, d?.pos ?? (mode === "edit" ? null : base?.pos));
      })
      .catch((e: Error) => setErr(e.message));
  };

  return (
    <Dialog title={TITLES[mode]} onClose={onClose} onOk={save} okLabel={t.common.save} width={680}>
      <div class="group" role="group" aria-labelledby="tr-row-msg">
        <div class="group-title" id="tr-row-msg">
          {t.tracer.message}
        </div>
        <div class="inline-row wrap">
          <label class="field">
            <span>{t.tx.channel}</span>
            <select class="inp" aria-label={t.tx.channel} value={ch} onChange={(e) => setCh((e.target as HTMLSelectElement).value)}>
              <option value="1">1</option>
              <option value="2">2</option>
            </select>
          </label>
          <label class="field">
            <span>{t.col.id}</span>
            <input
              class="inp mono"
              style={{ width: "96px" }}
              aria-label={t.col.id}
              value={id}
              maxLength={8}
              spellcheck={false}
              onInput={(e) => setId((e.target as HTMLInputElement).value.toUpperCase())}
            />
          </label>
          <Check checked={ext} onChange={setExt} label={t.tx.bit29} />
          <label class="field">
            <span>{t.col.dlc}</span>
            <select class="inp" aria-label={t.col.dlc} value={String(dlc)} onChange={(e) => setDlc(Number((e.target as HTMLSelectElement).value))}>
              {Array.from({ length: 9 }, (_, n) => (
                <option value={String(n)}>{n}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div class="group" role="group" aria-labelledby="tr-row-flags">
        <div class="group-title" id="tr-row-flags">
          {t.tracer.flags}
        </div>
        <Check checked={rtr} onChange={setRtr} label="RTR" />
      </div>
      <div class="group" role="group" aria-labelledby="tr-row-opt">
        <div class="group-title" id="tr-row-opt">
          {t.tracer.options}
        </div>
        <div class="inline-row wrap">
          <span>{t.tracer.pauseMs}</span>
          <label class="field">
            <span>{t.tracer.before}</span>
            <input
              class="inp mono"
              style={{ width: "70px" }}
              aria-label={t.tracer.beforeLabel}
              inputMode="numeric"
              value={before}
              onInput={(e) => setBefore((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="field">
            <span>{t.tracer.after}</span>
            <input
              class="inp mono"
              style={{ width: "70px" }}
              aria-label={t.tracer.afterLabel}
              inputMode="numeric"
              value={after}
              onInput={(e) => setAfter((e.target as HTMLInputElement).value)}
            />
          </label>
          <span class="tool-spacer" />
          <label class="field">
            <span>{t.tx.value}</span>
            <input
              class="inp mono"
              style={{ width: "44px" }}
              aria-label={t.tx.value}
              value={value}
              maxLength={2}
              onInput={(e) => setValue((e.target as HTMLInputElement).value.toUpperCase())}
            />
          </label>
          <button type="button" class="btn" onClick={fill}>
            {t.tx.fill}
          </button>
        </div>
      </div>
      <div class="group" role="group" aria-labelledby="tr-row-data">
        <div class="group-title" id="tr-row-data">
          {t.tracer.rawData}
        </div>
        <ByteCells count={8} value={bytes} onChange={setBytes} label={t.col.data} active={dlc} />
      </div>
      <div class="err-line" role={err ? "alert" : undefined}>
        {err}
      </div>
    </Dialog>
  );
}
