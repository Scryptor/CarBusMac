/** Живой монитор: таблица, сгруппированная по (ch,id,ext), значения обновляются
 * на месте, изменившиеся байты подсвечиваются. Клик по строке открывает карту бит. */
import { client } from "./app";
import type { ServerEvent } from "./ws";
import { formatId } from "./lib/format";
import { changedByteIndices } from "./lib/bits";
import { selectMessage } from "./bitmap";

export interface DeltaRow {
  ch: number;
  id: number;
  ext: boolean;
  dlc: number;
  data: string; // hex
  count: number;
  period_ms: number | null;
  changed_mask: number;
  ts: number;
}

interface RowView {
  tr: HTMLTableRowElement;
  byteCells: HTMLSpanElement[];
  cells: { dlc: HTMLElement; cnt: HTMLElement; per: HTMLElement };
}

const views = new Map<string, RowView>();
let tbody: HTMLTableSectionElement | null = null;

export function hexToBytes(hex: string): number[] {
  return (hex.match(/../g) ?? []).map((h) => parseInt(h, 16));
}

const keyOf = (r: DeltaRow): string => `${r.ch}:${r.id}:${r.ext ? "x" : "s"}`;

export function initMonitor(): void {
  const host = document.getElementById("monitor");
  if (!host) return;
  host.innerHTML = `<table class="grid"><thead><tr>
      <th>CH</th><th>ID</th><th>DLC</th><th class="data">Data</th>
      <th>Cnt</th><th>Period</th></tr></thead><tbody></tbody></table>`;
  tbody = host.querySelector("tbody");

  client.on("monitor_delta", (e: ServerEvent) => {
    for (const r of (e.rows as DeltaRow[]) ?? []) upsert(r);
  });
  client.on("status", (e: ServerEvent) => {
    if (!e.connected) clearMonitor();
  });
}

export function clearMonitor(): void {
  views.clear();
  if (tbody) tbody.innerHTML = "";
}

function upsert(r: DeltaRow): void {
  if (!tbody) return;
  const key = keyOf(r);
  const bytes = hexToBytes(r.data);
  let v = views.get(key);
  if (!v) v = create(key, r);
  // данные по байтам + подсветка изменившихся
  const changed = new Set(changedByteIndices(r.changed_mask));
  v.byteCells.forEach((span, i) => {
    span.textContent = i < bytes.length ? bytes[i].toString(16).toUpperCase().padStart(2, "0") : "";
    if (changed.has(i) && i < bytes.length) flash(span);
  });
  v.cells.dlc.textContent = String(r.dlc);
  v.cells.cnt.textContent = String(r.count);
  v.cells.per.textContent = r.period_ms == null ? "" : r.period_ms.toFixed(1);
}

function create(key: string, r: DeltaRow): RowView {
  const tr = document.createElement("tr");
  const tdCh = td(tr, String(r.ch));
  td(tr, formatId(r.id, r.ext));
  const tdDlc = td(tr, "");
  const tdData = document.createElement("td");
  tdData.className = "data";
  const byteCells: HTMLSpanElement[] = [];
  for (let i = 0; i < 8; i++) {
    const s = document.createElement("span");
    s.className = "byte";
    byteCells.push(s);
    tdData.appendChild(s);
  }
  tr.appendChild(tdData);
  const tdCnt = td(tr, "");
  const tdPer = td(tr, "");
  tr.addEventListener("click", () => {
    for (const el of tbody!.querySelectorAll("tr.sel")) el.classList.remove("sel");
    tr.classList.add("sel");
    selectMessage(key, { ch: r.ch, id: r.id, ext: r.ext });
  });
  tbody!.appendChild(tr);
  void tdCh;
  const v: RowView = { tr, byteCells, cells: { dlc: tdDlc, cnt: tdCnt, per: tdPer } };
  views.set(key, v);
  return v;
}

function td(tr: HTMLTableRowElement, text: string): HTMLElement {
  const c = document.createElement("td");
  c.textContent = text;
  tr.appendChild(c);
  return c;
}

function flash(span: HTMLSpanElement): void {
  span.classList.remove("chg");
  // перезапуск анимации
  void span.offsetWidth;
  span.classList.add("chg");
}
