/** Панель канала/битрейта и фильтров: открытие CAN-канала (пресет/ручной тайминг),
 * аппаратные фильтры (→ backend) и программный диапазон (→ клиентский фильтр потока). */
import { client } from "./app";
import { PRESET_BITRATES, sampleToTiming } from "./lib/timing";
import { setRangeFilter } from "./stream";

const CLOCK_HZ = 120_000_000;

function parseId(s: string): number {
  const v = parseInt(s.trim(), 16);
  if (Number.isNaN(v) || v < 0) throw new Error(`bad id: ${s}`);
  return v;
}

export function initFilters(): void {
  const host = document.getElementById("filters");
  if (!host) return;
  host.innerHTML = `
    <div class="hd">Channel</div>
    <div class="form">
      <label>CH <select id="chSel"><option>1</option><option>2</option></select></label>
      <label>bitrate <select id="brSel">${PRESET_BITRATES.map((b) => `<option value="${b}">${b / 1000} kbps</option>`).join("")}</select></label>
      <label><input type="checkbox" id="listenOnly" /> listen-only</label>
      <button id="btnOpenChannel">Open</button>
      <span id="brTiming" class="muted"></span>
    </div>
    <div class="hd">Hardware filter</div>
    <div class="form">
      <label>CH <input id="hwCh" value="1" size="2" /></label>
      <label>idx <input id="hwIdx" value="0" size="2" /></label>
      <label><input type="checkbox" id="hwExt" /> 29-bit</label>
      <label>ID <input id="hwId" value="000" size="8" /></label>
      <label>mask <input id="hwMask" value="7FF" size="8" /></label>
      <button id="btnHwSet">Set</button>
      <button id="btnHwClear">Clear CH</button>
    </div>
    <div class="hd">Range filter (поток)</div>
    <div class="form">
      <label>from <input id="rgFrom" size="8" /></label>
      <label>to <input id="rgTo" size="8" /></label>
      <label><input type="checkbox" id="rgExclude" /> exclude</label>
      <button id="btnRange">Apply</button>
    </div>
    <div id="filterErr" class="err"></div>`;

  const err = host.querySelector<HTMLElement>("#filterErr")!;
  const guard = (fn: () => void) => {
    try {
      err.textContent = "";
      fn();
    } catch (e) {
      err.textContent = String((e as Error).message);
    }
  };
  const val = (id: string) => host.querySelector<HTMLInputElement>("#" + id)!.value;
  const checked = (id: string) => host.querySelector<HTMLInputElement>("#" + id)!.checked;

  const brSel = host.querySelector<HTMLSelectElement>("#brSel")!;
  const brTiming = host.querySelector<HTMLElement>("#brTiming")!;
  const showTiming = () => {
    try {
      const t = sampleToTiming(Number(brSel.value), CLOCK_HZ, 80);
      brTiming.textContent = `presc ${t.prescaler}, seg1 ${t.seg1}, seg2 ${t.seg2}, sjw ${t.sjw}`;
    } catch {
      brTiming.textContent = "нет целого тайминга";
    }
  };
  brSel.addEventListener("change", showTiming);
  showTiming();

  host.querySelector("#btnOpenChannel")!.addEventListener("click", () =>
    client.send({
      type: "open_channel",
      channel: Number(val("chSel")),
      bitrate: Number(brSel.value),
      listen_only: checked("listenOnly"),
    }),
  );
  host.querySelector("#btnHwSet")!.addEventListener("click", () =>
    guard(() =>
      client.send({
        type: "set_hw_filter",
        channel: Number(val("hwCh")),
        index: Number(val("hwIdx")),
        can_id: parseId(val("hwId")),
        mask: parseId(val("hwMask")),
        extended: checked("hwExt"),
      }),
    ),
  );
  host.querySelector("#btnHwClear")!.addEventListener("click", () =>
    guard(() => client.send({ type: "clear_filters", channel: Number(val("hwCh")) })),
  );
  host.querySelector("#btnRange")!.addEventListener("click", () =>
    guard(() =>
      setRangeFilter({
        from: val("rgFrom") ? parseId(val("rgFrom")) : undefined,
        to: val("rgTo") ? parseId(val("rgTo")) : undefined,
        exclude: checked("rgExclude"),
      }),
    ),
  );
}
