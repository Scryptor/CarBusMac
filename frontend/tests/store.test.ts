import { beforeEach, expect, test } from "vitest";
import { applyEvent, resetStore, store } from "../src/core/store";

const hello = {
  type: "hello",
  status: { type: "status", state: "opened", message: "", device_info: { hardware_name: "HW_CH32" }, channels: { "1": { open: true } } },
  settings: { theme: "dark", mark_hold_ms: 2000 },
  comments: { "291:0": "кнопка" },
  connection: { bridge_host: "h", bridge_port: 7000, channels: [] },
  bitrates: [],
  monitor: [],
  capture: { type: "capture_state", recording: true, count: 5, duration_s: 1.5, full: false, rev: 0, markers: [] },
  tx: { tasks: [{ id: "t1", count: 0 }] },
  filters: { type: "filters_state", hw: [], hw_layout: { "1": 14 }, ranges: [] },
  tracer: { type: "tracer_state", name: null, count: 0, state: "stopped", current: null, rev: 0, config: {}, channels: [], modified: false, breakpoints: [] },
};

beforeEach(() => resetStore());

test("hello populates every slice", () => {
  applyEvent(hello);
  expect(store.status.value.state).toBe("opened");
  expect(store.settings.value.theme).toBe("dark");
  expect(store.comments.value["291:0"]).toBe("кнопка");
  expect(store.capture.value.count).toBe(5);
  expect(store.tasks.value[0].id).toBe("t1");
  expect(store.filters.value.hw_layout["1"]).toBe(14);
});

test("capture_tail updates count and duration without touching markers", () => {
  applyEvent(hello);
  applyEvent({ type: "capture_tail", count: 9, duration_s: 3, rev: 0, start: 0, rows: [] });
  expect(store.capture.value.count).toBe(9);
  expect(store.capture.value.duration_s).toBe(3);
  expect(store.capture.value.recording).toBe(true);
});

test("tx_counts merges counters into tasks", () => {
  applyEvent(hello);
  applyEvent({ type: "tx_counts", counts: { t1: 42 } });
  expect(store.tasks.value[0].count).toBe(42);
});

test("tracer_progress updates current row and state", () => {
  applyEvent(hello);
  applyEvent({ type: "tracer_progress", current: 7, state: "playing" });
  expect(store.tracer.value.current).toBe(7);
  expect(store.tracer.value.state).toBe("playing");
});

test("stats and toast are stored", () => {
  applyEvent({ type: "stats", rx_per_s: 512, tx_per_s: 3 });
  applyEvent({ type: "toast", level: "info", message: "Поток данных сохранён!" });
  expect(store.stats.value.rx_per_s).toBe(512);
  expect(store.toasts.value[0].message).toBe("Поток данных сохранён!");
});
