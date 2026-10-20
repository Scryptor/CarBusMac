/** Форматирование значений таблиц как в русском десктопе (запятая в дробях) и разбор
 * пользовательского ввода ID/байт с понятными ошибками. */
import { t } from "../i18n/ru";

export function fmtId(id: number, ext: boolean, hex: boolean): string {
  if (!hex) return String(id);
  return id.toString(16).toUpperCase().padStart(ext ? 8 : 3, "0");
}

export function fmtHex(v: number, width: number): string {
  return v.toString(16).toUpperCase().padStart(width, "0");
}

export function fmtData(hex: string): string[] {
  return (hex.match(/../g) ?? []).map((b) => b.toUpperCase());
}

export function hexToBytes(hex: string): number[] {
  return (hex.match(/../g) ?? []).map((b) => parseInt(b, 16));
}

export function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fmtAscii(hex: string): string {
  return hexToBytes(hex)
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
    .join("");
}

function fixedComma(v: number, digits: number): string {
  return v.toFixed(digits).replace(".", ",");
}

/** Секунды → «12,453». */
export function fmtTime(sec: number): string {
  return fixedComma(Math.floor(sec * 1000 + 1e-6) / 1000, 3);
}

/** Период, мс → «19,999»; null → пусто. */
export function fmtPeriod(ms: number | null): string {
  return ms == null ? "" : fixedComma(Math.floor(ms * 1000 + 1e-6) / 1000, 3);
}

export function fmtFlags(r: { rtr: boolean; fd: boolean; brs: boolean }): string {
  const base = r.fd ? (r.brs ? "FD BRS" : "FD") : "CAN";
  return r.rtr ? `${base} RTR` : base;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return t.units.b(bytes);
  if (bytes < 1024 * 1024) return t.units.kb(fixedComma(bytes / 1024, 1));
  return t.units.mb(fixedComma(bytes / 1024 / 1024, 1));
}

export function parseHexId(s: string, ext: boolean): number {
  const txt = s.trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]{1,8}$/i.test(txt)) throw new Error(t.err.badId);
  const v = parseInt(txt, 16);
  const max = ext ? 0x1fffffff : 0x7ff;
  if (v > max) throw new Error(t.err.idRange(ext ? 29 : 11, max.toString(16).toUpperCase()));
  return v;
}

/** «A5» → 0xA5; пустая строка → null (если разрешено). */
export function parseHexByte(s: string, allowEmpty = false): number | null {
  const txt = s.trim();
  if (txt === "") {
    if (allowEmpty) return null;
    throw new Error(t.err.emptyByte);
  }
  if (!/^[0-9a-f]{1,2}$/i.test(txt)) throw new Error(t.err.badByte(txt));
  return parseInt(txt, 16);
}

export function parseIntRange(s: string, min: number, max: number, what: string): number {
  const txt = s.trim();
  if (!/^-?\d+$/.test(txt)) throw new Error(t.err.notInt(what));
  const v = Number(txt);
  if (v < min || v > max) throw new Error(t.err.range(what, min, max));
  return v;
}
