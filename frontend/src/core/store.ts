/** Глобальное состояние фронта на сигналах. Всё, что присылает сервер, проходит через
 * `applyEvent`; строки монитора и потока живут в своих хранилищах (features/*),
 * потому что обновляются 25 раз в секунду и не должны дёргать перерисовку всего UI. */
import { signal } from "@preact/signals";
import type {
  CaptureState,
  ConnectionConfig,
  CustomBitrate,
  FiltersState,
  Settings,
  StatusState,
  TracerState,
  TxTaskJson,
} from "./types";

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  grid_font: "SF Mono",
  grid_font_size: 13,
  mark_changed: true,
  mark_color: "#e0a526",
  mark_hold_ms: 2000,
  aggregator: false,
  rare_mode: false,
  rare_period_ms: 10000,
  monitor_hex_ids: true,
  monitor_sort: false,
  monitor_group_by_channel: false,
  restore_tx_on_start: true,
  tracer_max_1s: false,
  copy_header: true,
  copy_id_hex: true,
  copy_data_hex: true,
  filter_new_active: true,
  filter_restore_on_start: true,
  filter_simple_mode: false,
  log_autostart: false,
  log_record_tx: true,
  log_name_mask: "%Y-%m-%d_%H-%M-%S",
  log_meta: { transport: "", brand: "", model: "", body: "", year: "" },
};

const EMPTY_STATUS: StatusState = { state: "closed", message: "", device_info: null, channels: {} };
const EMPTY_CAPTURE: CaptureState = { recording: false, count: 0, duration_s: 0, full: false, rev: 0, markers: [] };
const EMPTY_FILTERS: FiltersState = { hw: [], hw_layout: {}, ranges: [] };
const EMPTY_TRACER: TracerState = {
  name: null,
  modified: false,
  count: 0,
  channels: [],
  rev: 0,
  state: "stopped",
  current: null,
  config: {
    delay_mode: "timestamp",
    fixed_ms: 100,
    max_1s: false,
    loop: false,
    dest: "ch1",
    only_channel: null,
    stop_on_bp: true,
    stop_on_rx: false,
  },
  breakpoints: [],
};

export interface Toast {
  id: number;
  level: "info" | "error";
  message: string;
}

export const store = {
  status: signal<StatusState>(EMPTY_STATUS),
  settings: signal<Settings>(DEFAULT_SETTINGS),
  comments: signal<Record<string, string>>({}),
  connection: signal<ConnectionConfig | null>(null),
  bitrates: signal<CustomBitrate[]>([]),
  capture: signal<CaptureState>(EMPTY_CAPTURE),
  tasks: signal<TxTaskJson[]>([]),
  filters: signal<FiltersState>(EMPTY_FILTERS),
  tracer: signal<TracerState>(EMPTY_TRACER),
  stats: signal<{ rx_per_s: number; tx_per_s: number }>({ rx_per_s: 0, tx_per_s: 0 }),
  toasts: signal<Toast[]>([]),
  helloSeq: signal(0),
};

let toastSeq = 0;

export function pushToast(level: Toast["level"], message: string): void {
  const t: Toast = { id: ++toastSeq, level, message };
  store.toasts.value = [...store.toasts.value.slice(-4), t];
  setTimeout(() => {
    store.toasts.value = store.toasts.value.filter((x) => x.id !== t.id);
  }, level === "error" ? 6000 : 3000);
}

export function resetStore(): void {
  store.status.value = EMPTY_STATUS;
  store.settings.value = DEFAULT_SETTINGS;
  store.comments.value = {};
  store.connection.value = null;
  store.bitrates.value = [];
  store.capture.value = EMPTY_CAPTURE;
  store.tasks.value = [];
  store.filters.value = EMPTY_FILTERS;
  store.tracer.value = EMPTY_TRACER;
  store.stats.value = { rx_per_s: 0, tx_per_s: 0 };
  store.toasts.value = [];
}

function stripType<T>(e: Record<string, unknown>): T {
  const { type: _t, ...rest } = e;
  return rest as T;
}

export function applyEvent(e: Record<string, unknown>): void {
  switch (e.type) {
    case "hello": {
      const h = e as Record<string, Record<string, unknown>>;
      applyEvent(h.status);
      store.settings.value = { ...DEFAULT_SETTINGS, ...(h.settings as unknown as Settings) };
      store.comments.value = h.comments as Record<string, string>;
      store.connection.value = h.connection as unknown as ConnectionConfig;
      store.bitrates.value = (e.bitrates as CustomBitrate[]) ?? [];
      applyEvent(h.capture);
      store.tasks.value = (h.tx.tasks as TxTaskJson[]) ?? [];
      applyEvent(h.filters);
      applyEvent(h.tracer);
      store.helloSeq.value++;
      break;
    }
    case "status":
      store.status.value = stripType<StatusState>(e);
      break;
    case "settings":
      store.settings.value = { ...DEFAULT_SETTINGS, ...(e.settings as Settings) };
      break;
    case "comments":
      store.comments.value = e.comments as Record<string, string>;
      break;
    case "bitrates":
      store.bitrates.value = e.bitrates as CustomBitrate[];
      break;
    case "capture_state":
      store.capture.value = stripType<CaptureState>(e);
      break;
    case "capture_tail":
      store.capture.value = {
        ...store.capture.value,
        count: Number(e.count),
        duration_s: Number(e.duration_s),
      };
      break;
    case "tx_state":
      store.tasks.value = e.tasks as TxTaskJson[];
      break;
    case "tx_counts": {
      const counts = e.counts as Record<string, number>;
      store.tasks.value = store.tasks.value.map((t) => (t.id in counts ? { ...t, count: counts[t.id] } : t));
      break;
    }
    case "filters_state":
      store.filters.value = stripType<FiltersState>(e);
      break;
    case "tracer_state":
      store.tracer.value = stripType<TracerState>(e);
      break;
    case "tracer_progress":
      store.tracer.value = {
        ...store.tracer.value,
        current: e.current as number | null,
        state: e.state as TracerState["state"],
      };
      break;
    case "stats":
      store.stats.value = { rx_per_s: Number(e.rx_per_s), tx_per_s: Number(e.tx_per_s) };
      break;
    case "toast":
      pushToast((e.level as Toast["level"]) ?? "info", String(e.message));
      break;
    case "error":
      pushToast("error", String(e.message));
      break;
  }
}

export function commentKey(id: number, ext: boolean): string {
  return `${id}:${ext ? 1 : 0}`;
}
