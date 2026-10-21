// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { handlers, calls } = vi.hoisted(() => ({
  handlers: {} as Record<string, ((e: Record<string, unknown>) => void)[]>,
  calls: [] as { type: string; args: Record<string, unknown> }[],
}));
vi.mock("../src/core/client", () => ({
  client: {
    on: (type: string, fn: (e: Record<string, unknown>) => void) => {
      (handlers[type] ??= []).push(fn);
      return () => {};
    },
    state: { value: "open" },
  },
  cmd: (type: string, args: Record<string, unknown> = {}) => {
    calls.push({ type, args });
    return Promise.resolve({});
  },
}));

import { dialog, ui } from "../src/app/ui";
import { clearActions, runAction } from "../src/core/actions";
import { applyEvent, resetStore } from "../src/core/store";
import type { FrameRowJson } from "../src/core/types";
import { ReceiveArea } from "../src/features/monitor/ReceiveArea";
import { registerStream } from "../src/features/stream/register";
import { MarkersDialog } from "../src/features/stream/dialogs";
import { StreamPanel, streamCache, streamSelection } from "../src/features/stream/StreamGrid";

/** Событие сервера так, как его разносит WS-клиент: сначала подписчики типа, потом стор. */
function emit(e: Record<string, unknown>) {
  act(() => {
    for (const h of handlers[e.type as string] ?? []) h(e);
    applyEvent(e);
  });
}

const row = (i: number, id = 0x100 + i): FrameRowJson => ({
  i, t: i / 100, ch: 1, dir: "rx", id, ext: false, rtr: false, dlc: 1, data: "01", marker: null,
});
const capture = (rev: number, count: number, extra: Record<string, unknown> = {}) => ({
  type: "capture_state", recording: true, count, duration_s: 1, full: false, rev, markers: [], ...extra,
});
const TRACER = {
  type: "tracer_state", name: null, modified: false, count: 0, visible: 0, channels: [], rev: 0, data_rev: 0,
  state: "stopped", current: null, pos: null, breakpoints: [],
  config: { delay_mode: "timestamp", fixed_ms: 100, max_1s: false, loop: false, dest: "ch1", only_channel: null,
    stop_on_bp: true, stop_on_rx: false },
};
/** Снимок после (пере)подключения к серверу. */
const hello = (rev: number) => ({
  type: "hello",
  status: { type: "status", state: "opened", message: "", device_info: null, channels: {} },
  settings: {}, comments: {}, connection: null, bitrates: [], monitor: [],
  capture: capture(rev, 0),
  tx: { tasks: [] },
  filters: { type: "filters_state", hw: [], hw_layout: {}, ranges: [] },
  tracer: TRACER,
});

function DialogHost() {
  return <>{dialog.value}</>;
}

beforeEach(() => {
  resetStore();
  clearActions();
  registerStream();
  calls.length = 0;
  ui.view.value = "main";
  ui.receiveMode.value = "stream";
  emit(hello(1));
});
afterEach(() => {
  cleanup();
  act(() => {
    dialog.value = null;
  });
});

test("the tail is kept only while the stream table is on screen", async () => {
  render(<StreamPanel />);
  emit(capture(1, 0));
  emit({ type: "capture_tail", count: 3, duration_s: 1, rev: 1, start: 0, rows: [row(0), row(1), row(2)] });
  expect(await screen.findByText("102")).toBeTruthy();
  expect(streamCache.size).toBe(3);
  cleanup();
  emit({ type: "capture_tail", count: 5, duration_s: 1, rev: 1, start: 3, rows: [row(3), row(4)] });
  expect(streamCache.size).toBe(3);
});

test("clearing or reloading the stream drops the selection with the rows", async () => {
  render(<StreamPanel />);
  emit(capture(1, 0));
  emit({ type: "capture_tail", count: 3, duration_s: 1, rev: 1, start: 0, rows: [row(0), row(1), row(2)] });
  fireEvent.mouseDown(await screen.findByText("101"));
  expect(streamSelection.value?.id).toBe(0x101);
  expect(document.querySelectorAll(".gr.sel").length).toBe(1);
  emit(capture(2, 0)); // «Очистить поток» / «Загрузить поток»: новая ревизия
  expect(streamSelection.value).toBeNull();
  expect(document.querySelectorAll(".gr.sel").length).toBe(0);
  // после переподключения (hello) — тоже
  emit({ type: "capture_tail", count: 3, duration_s: 1, rev: 2, start: 0, rows: [row(0), row(1), row(2)] });
  fireEvent.mouseDown(await screen.findByText("102"));
  expect(streamSelection.value?.id).toBe(0x102);
  emit(hello(2));
  expect(streamSelection.value).toBeNull();
});

test("«К метке» from the monitor switches to the stream and scrolls to the marker", async () => {
  ui.receiveMode.value = "monitor";
  emit(capture(1, 500, { markers: [{ index: 400, label: "#1", comment: "", auto: true }] }));
  render(
    <>
      <ReceiveArea />
      <DialogHost />
    </>,
  );
  act(() => {
    dialog.value = <MarkersDialog />;
  });
  fireEvent.click(screen.getByRole("button", { name: "К метке" }));
  await act(() => new Promise((r) => setTimeout(r, 50)));
  expect(ui.receiveMode.value).toBe("stream");
  const grid = screen.getByRole("grid", { name: "Приём [ Поток данных ]" });
  const at = grid.scrollTop;
  expect(at).toBeGreaterThan(400 * 22 - 400);
  // запись идёт: новые кадры сразу после перехода не утягивают таблицу к концу
  emit(capture(1, 520, { markers: [{ index: 400, label: "#1", comment: "", auto: true }] }));
  emit({ type: "capture_tail", count: 540, duration_s: 2, rev: 1, start: 520, rows: [] });
  expect(grid.scrollTop).toBe(at);
});

test("Ctrl+F12 asks before replacing a modified trace in the tracer", async () => {
  render(<DialogHost />);
  emit(capture(1, 10));
  emit({ ...TRACER, name: "drive.trc", modified: true, count: 3, visible: 3, channels: [1], rev: 1 });
  act(() => void runAction("toTracer"));
  expect(screen.getByText("Трейс изменён и не сохранён. Продолжить без сохранения?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Нет" }));
  await act(() => new Promise((r) => setTimeout(r, 0)));
  expect(calls.some((c) => c.type === "capture_to_tracer")).toBe(false);
  act(() => void runAction("toTracer"));
  fireEvent.click(screen.getByRole("button", { name: "Да" }));
  await act(() => new Promise((r) => setTimeout(r, 0)));
  expect(calls.some((c) => c.type === "capture_to_tracer")).toBe(true);
});

test("the tail does not grow the cache past its limit even while the table is open", async () => {
  render(<StreamPanel />);
  emit(capture(1, 0));
  const many = (start: number, n: number) => Array.from({ length: n }, (_, k) => row(start + k));
  emit({ type: "capture_tail", count: 100, duration_s: 1, rev: 1, start: 0, rows: many(0, 100) });
  // пользователь ушёл наверх (Home): таблица больше не следует за концом записи
  fireEvent.keyDown(screen.getByRole("grid"), { key: "Home" });
  await screen.findByText("100");
  // таблица просила первые строки (пользователь наверху), а запись ушла далеко вперёд
  for (let k = 1; k <= 30; k++) {
    emit({ type: "capture_tail", count: (k + 1) * 1000, duration_s: k, rev: 1, start: k * 1000, rows: many(k * 1000, 1000) });
  }
  expect(streamCache.size).toBeLessThanOrEqual(20000 + 1000);
  expect(streamCache.get(3)?.i).toBe(3); // видимые строки на месте
});

test("Ctrl+N asks before wiping an unsaved stream; a saved one is cleared at once", async () => {
  const { registerMonitorActions } = await import("../src/features/monitor/actions");
  registerMonitorActions();
  render(<DialogHost />);
  emit(capture(1, 3, { dirty: true, markers: [{ index: 1, label: "#1", comment: "", auto: true }] }));
  act(() => void runAction("clear"));
  expect(await screen.findByText("Поток не сохранён: 3 кадра, 1 метка. Очистить его?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Нет" }));
  await act(() => new Promise((r) => setTimeout(r, 0)));
  expect(calls.some((c) => c.type === "capture_clear")).toBe(false);
  emit(capture(1, 3, { dirty: false }));                       // сохранили — спрашивать нечего
  await act(async () => void runAction("clear"));
  expect(calls.some((c) => c.type === "capture_clear")).toBe(true);
});

test("«Сбросить комментарии» is unavailable without comments and asks before deleting them", async () => {
  const { registerMonitorActions } = await import("../src/features/monitor/actions");
  registerMonitorActions();
  render(<DialogHost />);
  act(() => applyEvent({ type: "comments", comments: {} }));
  expect(runAction("commentsClear")).toBe(false);
  act(() => applyEvent({ type: "comments", comments: { "291:0": "кнопка", "292:0": "фары" } }));
  act(() => void runAction("commentsClear"));
  expect(await screen.findByText("Удалить все комментарии к сообщениям (2)? Это не отменить.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Да" }));
  await act(() => new Promise((r) => setTimeout(r, 0)));
  expect(calls.some((c) => c.type === "comments_clear")).toBe(true);
});
