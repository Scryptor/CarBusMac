/** Поток приёма (хронология) с паузой и программным фильтром по диапазону ID. */
import { client } from "./app";
import type { ServerEvent } from "./ws";
import { formatId, formatData } from "./lib/format";
import { matchIdFilter, type RangeSpec } from "./lib/idfilter";
import { hexToBytes, type DeltaRow } from "./monitor";

interface StreamFrame extends DeltaRow {
  dir: string;
}

const MAX_ROWS = 2000;
let paused = false;
let range: RangeSpec = {};
let body: HTMLElement | null = null;

export function setRangeFilter(spec: RangeSpec): void {
  range = spec;
}

export function initStream(): void {
  const host = document.getElementById("stream");
  if (!host) return;
  host.innerHTML =
    `<div class="bar"><button id="streamPause">Pause</button>` +
    `<span class="muted">фильтр диапазона — на вкладке Filters</span></div>` +
    `<div id="streamBody" class="log"></div>`;
  body = host.querySelector("#streamBody");
  const pauseBtn = host.querySelector<HTMLButtonElement>("#streamPause")!;
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    pauseBtn.classList.toggle("active", paused);
  });

  client.on("stream", (e: ServerEvent) => {
    if (paused || !body) return;
    for (const f of (e.frames as StreamFrame[]) ?? []) {
      if (matchIdFilter(f.id, range)) append(f);
    }
    while (body.childElementCount > MAX_ROWS) body.removeChild(body.firstChild!);
    body.scrollTop = body.scrollHeight;
  });
  client.on("status", (e: ServerEvent) => {
    if (!e.connected && body) body.innerHTML = "";
  });
}

function append(f: StreamFrame): void {
  const line = document.createElement("div");
  line.className = "logline";
  line.textContent =
    `${f.ts.toFixed(3)}  CH${f.ch}  ${formatId(f.id, f.ext)}  [${f.dlc}]  ` +
    `${formatData(hexToBytes(f.data))}  ${f.dir}`;
  body!.appendChild(line);
}
