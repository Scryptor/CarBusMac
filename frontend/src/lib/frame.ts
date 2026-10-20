/** Разбор и валидация полей кадра передачи (ID 11/29 бит, данные hex). */

export interface TxForm {
  channel: number;
  id: string;
  data: string;
  extended: boolean;
  rtr?: boolean;
  fd?: boolean;
  brs?: boolean;
}

export interface FrameMsg {
  channel: number;
  can_id: number;
  data: string; // нормализованный hex без разделителей
  extended: boolean;
  rtr: boolean;
  fd: boolean;
  brs: boolean;
}

export function parseHexBytes(s: string): number[] {
  const compact = s.replace(/\s+/g, "");
  if (compact === "") return [];
  if (compact.length % 2 !== 0) throw new Error("нечётное число hex-символов");
  const out: number[] = [];
  for (let i = 0; i < compact.length; i += 2) {
    const byte = compact.slice(i, i + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(byte)) throw new Error(`не hex: ${byte}`);
    out.push(parseInt(byte, 16));
  }
  if (out.length > 64) throw new Error("не более 64 байт");
  return out;
}

export function parseCanId(s: string, extended: boolean): number {
  const v = parseInt(s.trim(), 16);
  if (Number.isNaN(v) || v < 0) throw new Error(`bad id: ${s}`);
  const max = extended ? 0x1fffffff : 0x7ff;
  if (v > max) throw new Error(`id > ${extended ? "29" : "11"}-bit range`);
  return v;
}

export function encodeTxFrame(form: TxForm): FrameMsg {
  const bytes = parseHexBytes(form.data);
  return {
    channel: form.channel,
    can_id: parseCanId(form.id, form.extended),
    data: bytes.map((b) => b.toString(16).padStart(2, "0")).join(""),
    extended: form.extended,
    rtr: Boolean(form.rtr),
    fd: Boolean(form.fd),
    brs: Boolean(form.brs),
  };
}
