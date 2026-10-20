/** Карта бит выбранного сообщения (аналог frmDetails): каждый байт — 8 бит
 * с колонками x80..x01, десятичное значение, изменившиеся биты подсвечиваются. */
import { client } from "./app";
import type { ServerEvent } from "./ws";
import { formatId } from "./lib/format";
import { byteToBits, diffBits } from "./lib/bits";
import { hexToBytes, type DeltaRow } from "./monitor";

const WEIGHTS = ["x80", "x40", "x20", "x10", "x08", "x04", "x02", "x01"];

let selected: string | null = null;
let prev: number[] = [];
let host: HTMLElement | null = null;

const keyOf = (ch: number, id: number, ext: boolean): string => `${ch}:${id}:${ext ? "x" : "s"}`;

export function initBitmap(): void {
  host = document.getElementById("bitmap");
  if (!host) return;
  host.innerHTML = `<div class="hd">Bytes bit map</div><div class="bm-empty">выберите ID в мониторе</div>`;
  client.on("monitor_delta", (e: ServerEvent) => {
    if (!selected) return;
    for (const r of (e.rows as DeltaRow[]) ?? []) {
      if (keyOf(r.ch, r.id, r.ext) === selected) render(hexToBytes(r.data));
    }
  });
}

export function selectMessage(key: string, meta: { ch: number; id: number; ext: boolean }): void {
  selected = key;
  prev = [];
  if (host) {
    host.innerHTML =
      `<div class="hd">Bytes bit map — <b>${formatId(meta.id, meta.ext)}</b> (CH${meta.ch})</div>` +
      `<div id="bmBody" class="bm"></div>` +
      `<label class="bm-comment">комментарий <input id="bmComment" /></label>`;
  }
}

function render(bytes: number[]): void {
  const body = document.getElementById("bmBody");
  if (!body) return;
  const header =
    `<div class="bm-row bm-head"><span class="bm-idx">#</span>` +
    WEIGHTS.map((w) => `<span class="bm-bit">${w}</span>`).join("") +
    `<span class="bm-dec">dec</span></div>`;
  const rows = bytes
    .map((b, i) => {
      const changed = new Set(prev.length ? diffBits(prev[i] ?? 0, b) : []);
      const bitCells = byteToBits(b)
        .map((on, pos) => {
          const cls = "bm-bit" + (on ? " on" : "") + (changed.has(pos) ? " chg" : "");
          return `<span class="${cls}">${on ? "1" : "0"}</span>`;
        })
        .join("");
      return `<div class="bm-row"><span class="bm-idx">${i}</span>${bitCells}<span class="bm-dec">${b}</span></div>`;
    })
    .join("");
  body.innerHTML = header + rows;
  prev = bytes.slice();
}
