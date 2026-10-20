/** UI записи и воспроизведения трейсов: Record/Stop, список файлов (GET /api/traces),
 * Tracer (Play/Stop/Step/Repeat, Only-for-channel, To-Monitor, speed). */
import { client } from "./app";
import { playerControls, type PlayerState } from "./lib/tracer";

let state: PlayerState = { playing: false };
let playBtn: HTMLButtonElement | null = null;

const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
const chk = (id: string) => (document.getElementById(id) as HTMLInputElement).checked;

export function initTracer(): void {
  const host = document.getElementById("tracer");
  if (!host) return;
  host.innerHTML = `
    <div class="hd">Record</div>
    <div class="form">
      <label>name <input id="recName" value="trace" size="12" /></label>
      <button id="recStart">● Record</button>
      <button id="recStop">■ Stop</button>
    </div>
    <div class="hd">Tracer</div>
    <div class="form">
      <select id="trFile"></select>
      <button id="trRefresh">↻</button>
      <button id="trLoad">Load</button>
    </div>
    <div class="form">
      <button id="plPlay">▶ Play</button>
      <button id="plStop">■ Stop</button>
      <button id="plStep">⤼ Step</button>
      <label><input type="checkbox" id="plRepeat" /> Repeat</label>
      <label><input type="checkbox" id="plToMon" /> To Monitor</label>
      <label>only CH <input id="plOnly" size="2" placeholder="all" /></label>
      <label>speed <input id="plSpeed" value="1" size="4" /></label>
    </div>`;

  playBtn = host.querySelector("#plPlay");

  host.querySelector("#recStart")!.addEventListener("click", () =>
    client.send({ type: "record_start", name: val("recName") }),
  );
  host.querySelector("#recStop")!.addEventListener("click", () => client.send({ type: "record_stop" }));
  host.querySelector("#trRefresh")!.addEventListener("click", refreshFiles);
  host.querySelector("#trLoad")!.addEventListener("click", () => {
    const name = val("trFile");
    if (name) client.send({ type: "tracer_load", name });
  });

  host.querySelector("#plPlay")!.addEventListener("click", () => {
    state = playerControls(state, "play");
    syncButtons();
    const only = val("plOnly").trim();
    client.send({
      type: "tracer_play",
      speed: Number(val("plSpeed")) || 1,
      repeat: chk("plRepeat"),
      to_monitor: chk("plToMon"),
      only_channel: only ? Number(only) : null,
    });
  });
  host.querySelector("#plStop")!.addEventListener("click", () => {
    state = playerControls(state, "stop");
    syncButtons();
    client.send({ type: "tracer_stop" });
  });
  host.querySelector("#plStep")!.addEventListener("click", () => {
    const next = playerControls(state, "step");
    if (next.stepped) client.send({ type: "tracer_step" });
    state = { playing: next.playing };
  });

  refreshFiles();
}

function syncButtons(): void {
  if (playBtn) playBtn.classList.toggle("active", state.playing);
}

async function refreshFiles(): Promise<void> {
  const sel = document.getElementById("trFile") as HTMLSelectElement | null;
  if (!sel) return;
  try {
    const files = (await (await fetch("/api/traces")).json()) as string[];
    sel.innerHTML = files.map((f) => `<option>${f}</option>`).join("");
  } catch {
    /* бэкенд недоступен — оставить список как есть */
  }
}
