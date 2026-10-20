/** «Копировать выделенные строки» (Ctrl+C): строки трейса в TSV для Excel — с
 * заголовком или без, ID и данные в HEX или DEC (настройки копирования). */
import { fmtAscii, fmtId, fmtTime, hexToBytes } from "../../core/format";
import { commentKey } from "../../core/store";
import type { TracerRowJson } from "../../core/types";
import { t } from "../../i18n/ru";

export type CopyCol = "n" | "time" | "ch" | "id" | "dlc" | "data" | "ascii" | "comment";

export const TRACE_COPY_COLUMNS: CopyCol[] = ["n", "time", "ch", "id", "dlc", "data", "comment"];

export interface CopyOptions {
  header: boolean;
  idHex: boolean;
  dataHex: boolean;
  /** комментарии ID («ID:29бит») — когда у строки своего нет */
  idComments?: Record<string, string>;
}

const TITLES: Record<CopyCol, string> = {
  n: t.tracer.colNum,
  time: t.col.time,
  ch: t.col.ch,
  id: t.col.id,
  dlc: t.col.dlc,
  data: t.col.data,
  ascii: t.col.ascii,
  comment: t.col.comment,
};

/** Ячейка TSV не может содержать табуляцию и перевод строки. */
const cell = (s: string) => s.replace(/[\t\r\n]+/g, " ");

function value(r: TracerRowJson, c: CopyCol, o: CopyOptions): string {
  switch (c) {
    case "n":
      return String(r.i + 1);
    case "time":
      return fmtTime(r.t);
    case "ch":
      return String(r.ch);
    case "id":
      return fmtId(r.id, r.ext, o.idHex);
    case "dlc":
      return String(r.dlc);
    case "data":
      return hexToBytes(r.data)
        .map((b) => (o.dataHex ? b.toString(16).toUpperCase().padStart(2, "0") : String(b)))
        .join(" ");
    case "ascii":
      return fmtAscii(r.data);
    case "comment":
      return r.comment || o.idComments?.[commentKey(r.id, r.ext)] || "";
  }
}

export function copyRows(rows: TracerRowJson[], cols: CopyCol[], o: CopyOptions): string {
  const lines = rows.map((r) => cols.map((c) => cell(value(r, c, o))).join("\t"));
  if (o.header) lines.unshift(cols.map((c) => TITLES[c]).join("\t"));
  return lines.map((l) => `${l}\n`).join("");
}
