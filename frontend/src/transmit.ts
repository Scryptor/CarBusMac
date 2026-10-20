/** Передача: композ кадра, список задач (одиночные/периодические), Shot/Run/Stop,
 * Run All/Stop All, сохранение/загрузка списка и триггеры (авто-TX по приёму). */
import { client } from "./app";
import { encodeTxFrame, parseHexBytes, parseCanId, type FrameMsg } from "./lib/frame";

interface Task {
  id: string;
  frame: FrameMsg;
  period_ms: number | null;
}

let seq = 0;
const tasks = new Map<string, Task>();
let listEl: HTMLElement | null = null;
let errEl: HTMLElement | null = null;

const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
const chk = (id: string) => (document.getElementById(id) as HTMLInputElement).checked;

function guard(fn: () => void): void {
  try {
    if (errEl) errEl.textContent = "";
    fn();
  } catch (e) {
    if (errEl) errEl.textContent = String((e as Error).message);
  }
}

export function initTransmit(): void {
  const host = document.getElementById("transmit");
  if (!host) return;
  host.innerHTML = `
    <div class="tabbar"><button class="active">CAN Transmit</button></div>
    <div class="form">
      <label>CH <input id="txCh" value="1" size="2" /></label>
      <label>ID <input id="txId" value="7E0" size="8" /></label>
      <label><input type="checkbox" id="txExt" /> 29b</label>
      <label><input type="checkbox" id="txRtr" /> RTR</label>
      <label>Data <input id="txData" value="02 3E 00" size="24" /></label>
      <label>Period ms <input id="txPeriod" size="6" placeholder="(одиночный)" /></label>
      <button id="txShot">Shot</button>
      <button id="txAdd">Add</button>
    </div>
    <div class="bar">
      <button id="txRunAll">Run All</button>
      <button id="txStopAll">Stop All</button>
      <button id="txSave">Save list</button>
      <label class="filebtn">Load list<input id="txLoad" type="file" accept=".json" hidden /></label>
    </div>
    <table class="grid"><thead><tr><th>ID</th><th>Data</th><th>Period</th><th></th></tr></thead>
      <tbody id="txList"></tbody></table>
    <div class="hd">Trigger (приём → отправка)</div>
    <div class="form">
      <label>CH <input id="trCh" value="1" size="2" /></label>
      <label>match ID <input id="trId" value="123" size="8" /></label>
      <label>data <input id="trData" value="10" size="10" /></label>
      <label>mask <input id="trMask" value="F0" size="10" /></label>
      <label>→ send ID <input id="trActId" value="321" size="8" /></label>
      <label>data <input id="trActData" value="01" size="10" /></label>
      <button id="trAdd">Add trigger</button>
    </div>
    <div id="txErr" class="err"></div>`;

  listEl = host.querySelector("#txList");
  errEl = host.querySelector("#txErr");

  const compose = (): FrameMsg =>
    encodeTxFrame({ channel: Number(val("txCh")), id: val("txId"), data: val("txData"), extended: chk("txExt"), rtr: chk("txRtr") });

  host.querySelector("#txShot")!.addEventListener("click", () =>
    guard(() => client.send({ type: "tx_shot", frame: compose() })),
  );
  host.querySelector("#txAdd")!.addEventListener("click", () =>
    guard(() => {
      const period = val("txPeriod").trim();
      addTask(compose(), period ? Number(period) : null);
    }),
  );
  host.querySelector("#txRunAll")!.addEventListener("click", () => client.send({ type: "tx_run_all" }));
  host.querySelector("#txStopAll")!.addEventListener("click", () => client.send({ type: "tx_stop_all" }));
  host.querySelector("#txSave")!.addEventListener("click", saveList);
  host.querySelector<HTMLInputElement>("#txLoad")!.addEventListener("change", loadList);
  host.querySelector("#trAdd")!.addEventListener("click", () =>
    guard(() =>
      client.send({
        type: "trigger_add",
        trigger: {
          channel: Number(val("trCh")),
          can_id: parseCanId(val("trId"), false),
          data: bytesHex(val("trData")),
          mask: bytesHex(val("trMask")),
          action: encodeTxFrame({ channel: Number(val("trCh")), id: val("trActId"), data: val("trActData"), extended: false }),
        },
      }),
    ),
  );
}

function bytesHex(s: string): string {
  return parseHexBytes(s).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function addTask(frame: FrameMsg, period_ms: number | null): void {
  const id = `t${++seq}`;
  const task: Task = { id, frame, period_ms };
  tasks.set(id, task);
  client.send({ type: "tx_add", task });
  renderList();
}

function renderList(): void {
  if (!listEl) return;
  listEl.innerHTML = "";
  for (const t of tasks.values()) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>0x${t.frame.can_id.toString(16).toUpperCase()}</td>` +
      `<td class="data">${t.frame.data}</td>` +
      `<td>${t.period_ms ?? "—"}</td>`;
    const actions = document.createElement("td");
    actions.append(
      btn("Run", () => client.send({ type: "tx_run", id: t.id })),
      btn("Stop", () => client.send({ type: "tx_stop", id: t.id })),
      btn("✕", () => {
        tasks.delete(t.id);
        client.send({ type: "tx_stop", id: t.id });
        renderList();
      }),
    );
    tr.appendChild(actions);
    listEl.appendChild(tr);
  }
}

function btn(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function saveList(): void {
  const blob = new Blob([JSON.stringify([...tasks.values()], null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tx-list.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function loadList(ev: Event): void {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () =>
    guard(() => {
      const arr = JSON.parse(String(reader.result)) as Task[];
      tasks.clear();
      for (const t of arr) {
        tasks.set(t.id, t);
        client.send({ type: "tx_add", task: t });
      }
      seq = Math.max(seq, arr.length);
      renderList();
    });
  reader.readAsText(file);
}
