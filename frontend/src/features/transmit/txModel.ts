/** Модель редактора задачи передачи: строковые поля формы ↔ JSON задачи, проверка с
 * указанием поля, заполнение данных одним значением, копирование принятого сообщения. */
import { bytesToHex, hexToBytes, parseHexByte, parseHexId, parseIntRange } from "../../core/format";
import type { TriggerJson, TxTaskJson } from "../../core/types";
import { t } from "../../i18n/ru";

export interface TaskForm {
  channel: string;
  id: string;
  ext: boolean;
  rtr: boolean;
  dlc: string;
  data: (number | null)[];
  comment: string;
  period: string;
  trigAction: TriggerJson["action"];
  trigDelay: string;
  trigCh: string;
  trigId: string;
  trigDlc: string;
  trigData: (number | null)[];
}

export class FieldError extends Error {
  constructor(
    readonly field: keyof TaskForm,
    message: string,
  ) {
    super(message);
  }
}

const EMPTY8 = (): (number | null)[] => Array(8).fill(null);

export function newTask(id: string): TxTaskJson {
  return {
    id,
    channel: 1,
    can_id: 0,
    ext: false,
    rtr: false,
    data: "0000000000000000",
    period_ms: 10,
    comment: "",
    running: false,
    count: 0,
    trigger: { action: "none", delay_ms: 0, channel: 0, can_id: null, ext: false, dlc: null, data: EMPTY8() },
  };
}

export function nextTaskId(tasks: { id: string }[]): string {
  let max = 0;
  for (const t of tasks) {
    const m = /^t(\d+)$/.exec(t.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `t${max + 1}`;
}

export function taskToForm(t: TxTaskJson): TaskForm {
  const data = hexToBytes(t.data);
  const tr = t.trigger;
  return {
    channel: String(t.channel),
    id: t.can_id.toString(16).toUpperCase().padStart(t.ext ? 8 : 3, "0"),
    ext: t.ext,
    rtr: t.rtr,
    dlc: String(data.length),
    data: Array.from({ length: 8 }, (_, i) => (i < data.length ? data[i] : 0)),
    comment: t.comment,
    period: String(t.period_ms),
    trigAction: tr.action,
    trigDelay: String(tr.delay_ms),
    trigCh: String(tr.channel),
    trigId: tr.can_id == null ? "" : tr.can_id.toString(16).toUpperCase(),
    trigDlc: tr.dlc == null ? "" : String(tr.dlc),
    trigData: Array.from({ length: 8 }, (_, i) => tr.data[i] ?? null),
  };
}

function wrap<T>(field: keyof TaskForm, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new FieldError(field, (e as Error).message);
  }
}

export function parseTaskForm(f: TaskForm, base: TxTaskJson): TxTaskJson {
  const can_id = wrap("id", () => parseHexId(f.id, f.ext));
  const dlc = wrap("dlc", () => parseIntRange(f.dlc, 0, 8, "DLC"));
  const period = wrap("period", () => parseIntRange(f.period, 1, 10000, t.tx.fieldPeriod));
  // у RTR данных нет, а DLC есть: храним DLC нулевых байт (как кадры RTR на сервере)
  const data = f.rtr ? Array<number>(dlc).fill(0) : f.data.slice(0, dlc).map((b) => b ?? 0);
  let trigger: TriggerJson = { ...base.trigger, action: "none" };
  if (f.trigAction !== "none") {
    const t_id = wrap("trigId", () => parseHexId(f.trigId, Number.parseInt(f.trigId || "0", 16) > 0x7ff));
    const t_delay = wrap("trigDelay", () => parseIntRange(f.trigDelay || "0", 0, 10000, t.tx.fieldDelay));
    const t_dlc = f.trigDlc.trim() === "" ? null : wrap("trigDlc", () => parseIntRange(f.trigDlc, 0, 8, t.tx.fieldTrigDlc));
    trigger = {
      action: f.trigAction,
      delay_ms: t_delay,
      channel: Number(f.trigCh) || 0,
      can_id: t_id,
      ext: t_id > 0x7ff,
      dlc: t_dlc,
      // байт за DLC триггера в кадре нет — условие на него никогда бы не выполнилось
      data: f.trigData.slice(0, 8).map((b, i) => (b == null || (t_dlc != null && i >= t_dlc) ? null : b)),
    };
  }
  return {
    ...base,
    channel: Number(f.channel) || 1,
    can_id,
    ext: f.ext,
    rtr: f.rtr,
    data: bytesToHex(data),
    period_ms: period,
    comment: f.comment.trim(),
    trigger,
  };
}

/** «Значение» + «Заполнить»: все байты данных = одно значение. */
export function fillData(value: string, dlc: number): number[] {
  const b = parseHexByte(value);
  return Array(dlc).fill(b as number);
}

/** «Копировать в TX-List»: задача из принятого сообщения (монитор, поток, трейс). */
export function taskFromRow(
  row: { ch: number; id: number; ext: boolean; rtr: boolean; data: string; dlc?: number },
  id: string,
  comment = "",
): TxTaskJson {
  // данные RTR поток присылает пустыми, а DLC — отдельно: задаче нужны DLC нулевых байт
  const data = row.rtr ? "00".repeat(row.dlc ?? row.data.length / 2) : row.data;
  return { ...newTask(id), channel: row.ch, can_id: row.id, ext: row.ext, rtr: row.rtr, data, comment };
}

export { EMPTY8 };
