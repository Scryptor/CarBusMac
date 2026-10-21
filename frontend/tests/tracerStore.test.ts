import { beforeEach, expect, test, vi } from "vitest";

const { handlers, replies } = vi.hoisted(() => ({
  handlers: {} as Record<string, (e: Record<string, unknown>) => void>,
  replies: {} as Record<string, unknown>,
}));
vi.mock("../src/core/client", () => ({
  client: {
    on: (type: string, fn: (e: Record<string, unknown>) => void) => {
      handlers[type] = fn;
      return () => {};
    },
    state: { value: "open" },
  },
  cmd: (type: string) => Promise.resolve(replies[type] ?? {}),
}));

import { applyEvent, resetStore, store } from "../src/core/store";
import type { PlayerConfig, TracerRowJson } from "../src/core/types";
import {
  delayText,
  destText,
  fetchTracerRange,
  idKey,
  placeCursorAfter,
  selectionPayload,
  syncTracerRev,
  tracerCache,
  tracerFound,
  tracerGrid,
  tracerIds,
  tracerPause,
  tracerScrollTo,
  tracerSel,
  tracerSelVersion,
} from "../src/features/tracer/tracerStore";
import { Selection } from "../src/ui/grid/selection";

const cfg: PlayerConfig = {
  delay_mode: "timestamp",
  fixed_ms: 100,
  max_1s: false,
  loop: false,
  dest: "ch1",
  only_channel: null,
  stop_on_bp: true,
  stop_on_rx: false,
};

const row = (pos: number): TracerRowJson => ({
  i: pos,
  pos,
  t: pos / 100,
  ch: 1,
  dir: "rx",
  id: 0x100,
  ext: false,
  rtr: false,
  dlc: 1,
  data: "01",
  marker: null,
  enabled: true,
  bp: false,
  start: false,
  finish: false,
  before_ms: 0,
  after_ms: 0,
  comment: "",
});

beforeEach(() => {
  syncTracerRev(-5);
  tracerSel.clear();
});

test("selectionPayload plays only a multi-row selection in play-selected mode", () => {
  const sel = new Selection();
  sel.click(3);
  expect(selectionPayload(sel, true)).toBeNull(); // одна строка — это курсор, а не выделение
  sel.shiftClick(5);
  expect(selectionPayload(sel, true)).toEqual([3, 4, 5]);
  expect(selectionPayload(sel, false)).toBeNull();
});

test("rev change drops cached rows and the selection", () => {
  syncTracerRev(1);
  tracerCache.put(0, [row(0)]);
  tracerSel.click(0);
  expect(syncTracerRev(1)).toBe(false);
  expect(tracerCache.get(0)).toBeDefined();
  expect(syncTracerRev(2)).toBe(true);
  expect(tracerCache.get(0)).toBeUndefined();
  expect(tracerSel.size).toBe(0);
});

test("status texts follow the player config", () => {
  expect(delayText(cfg)).toBe("Авто");
  expect(delayText({ ...cfg, max_1s: true })).toBe("Авто, макс. 1 с");
  expect(delayText({ ...cfg, delay_mode: "fixed", fixed_ms: 120 })).toBe("120 мс");
  expect(destText({ ...cfg, dest: "ch2" })).toBe("Передача в канал 2");
  expect(destText({ ...cfg, dest: "monitor" })).toBe("Передача в монитор");
});

test("idKey separates channel and 11/29-bit ids", () => {
  expect(idKey({ ch: 1, id: 0x100, ext: false })).not.toBe(idKey({ ch: 2, id: 0x100, ext: false }));
  expect(idKey({ ch: 1, id: 0x100, ext: false })).not.toBe(idKey({ ch: 1, id: 0x100, ext: true }));
});

test("rows load after a page reload: the hello snapshot carries the trace revision", async () => {
  resetStore();
  handlers.hello({ type: "hello", tracer: { rev: 7 } });
  applyEvent({ type: "tracer_state", rev: 7, count: 3, visible: 3 } as never);
  replies.tracer_rows = { rev: 7, rows: [row(0), row(1), row(2)] };
  fetchTracerRange(0, 3);
  await new Promise((r) => setTimeout(r, 0));
  expect(tracerCache.get(2)?.pos).toBe(2);
});

test("a data revision refreshes rows but keeps the selection", async () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  handlers.hello({ type: "hello", tracer: { rev: 9, data_rev: 1 } });
  applyEvent({ type: "tracer_state", rev: 9, data_rev: 1, count: 3, visible: 3 } as never);
  replies.tracer_rows = { rev: 9, data_rev: 1, rows: [row(0), row(1), row(2)] };
  fetchTracerRange(0, 3);
  await tick();
  tracerSel.click(1);
  handlers.tracer_state({ type: "tracer_state", rev: 9, data_rev: 2 });
  expect(tracerCache.get(1)).toBeUndefined();
  expect(tracerSel.selected()).toEqual([1]);
  fetchTracerRange(0, 3); // ответ со старыми данными — отбрасываем
  await tick();
  expect(tracerCache.get(1)).toBeUndefined();
});

test("the tracer cache stays bounded while a long trace is scrolled or played", () => {
  handlers.hello({ type: "hello", tracer: { rev: 12, data_rev: 0 } });
  applyEvent({ type: "tracer_state", rev: 12, data_rev: 0, count: 60000, visible: 60000 } as never);
  tracerCache.put(0, Array.from({ length: 30000 }, (_, i) => row(i)));
  fetchTracerRange(29000, 29050);
  expect(tracerCache.size).toBeLessThanOrEqual(29050 + 2000 - (29000 - 2000));
  expect(tracerCache.get(29010)?.pos).toBe(29010);
  expect(tracerCache.get(0)).toBeUndefined();
});

test("the table follows the current row on a step and at a breakpoint, not only while playing", () => {
  const scrollToRow = vi.fn();
  tracerGrid.ctl = { scrollToRow, focus: () => {} };
  try {
    handlers.tracer_progress({ type: "tracer_progress", current: 50, pos: 40, state: "paused" }); // F8 / точка останова
    expect(scrollToRow).toHaveBeenLastCalledWith(40);
    handlers.tracer_progress({ type: "tracer_progress", current: 51, pos: 41, state: "playing" });
    expect(scrollToRow).toHaveBeenLastCalledWith(41);
    scrollToRow.mockClear();
    handlers.tracer_progress({ type: "tracer_progress", current: 60, pos: null, state: "paused" }); // строка скрыта фильтром ID
    handlers.tracer_progress({ type: "tracer_progress", current: null, pos: null, state: "stopped" });
    expect(scrollToRow).not.toHaveBeenCalled();
  } finally {
    tracerGrid.ctl = null;
  }
});

test("hello refreshes the ID table and everything that depends on the selection", async () => {
  const ids = [{ ch: 1, id: 0x100, ext: false, count: 3, enabled: true }];
  replies.tracer_ids = { ids };
  tracerIds.value = [];
  const v = tracerSelVersion.value;
  handlers.hello({ type: "hello", tracer: { rev: 20, data_rev: 0 } });
  await new Promise((r) => setTimeout(r, 0));
  expect(tracerIds.value).toEqual(ids);
  expect(tracerSelVersion.value).toBeGreaterThan(v);
});

test("after an own edit the cursor lands where the server says, whether the reply or the new revision comes first", () => {
  handlers.hello({ type: "hello", tracer: { rev: 30, data_rev: 0 } });
  applyEvent({ type: "tracer_state", rev: 30, data_rev: 0, count: 10, visible: 10 } as never);
  tracerSel.click(4);
  // обычный порядок: tracer_state с новой ревизией (выделение сброшено), потом ответ команды
  handlers.tracer_state({ type: "tracer_state", rev: 31, data_rev: 1, visible: 9 });
  expect(tracerSel.focus).toBeNull();
  placeCursorAfter(31, 4);
  expect(tracerSel.focus).toBe(4);
  expect(tracerScrollTo.value?.pos).toBe(4); // таблица докрутит до курсора, когда перерисуется
  // ответ раньше состояния: курсор встаёт, когда придёт ревизия, к которой он относится
  placeCursorAfter(32, 3);
  expect(tracerSel.focus).toBe(4);
  handlers.tracer_state({ type: "tracer_state", rev: 32, data_rev: 2, visible: 8 });
  expect(tracerSel.focus).toBe(3);
  // правка, не сдвинувшая позиции (ревизия та же), выделение не трогает
  tracerSel.click(1);
  tracerSel.ctrlClick(5);
  placeCursorAfter(32, 7);
  expect(tracerSel.selected()).toEqual([1, 5]);
});

test("the «Найти сообщения» highlight belongs to the trace: an edit keeps it, another trace drops it", () => {
  handlers.hello({ type: "hello", tracer: { rev: 40, data_rev: 0, gen: 3 } });
  tracerFound.value = new Set([idKey({ ch: 1, id: 0x100, ext: false })]);
  handlers.tracer_state({ type: "tracer_state", rev: 41, data_rev: 1, gen: 3, visible: 5 }); // правка, фильтр ID
  expect(tracerFound.value.size).toBe(1);
  handlers.tracer_state({ type: "tracer_state", rev: 42, data_rev: 2, gen: 4, visible: 0 }); // «Новый», «Открыть»
  expect(tracerFound.value.size).toBe(0);
});

test("a pause on received data says why; a pause by the user does not", () => {
  resetStore();
  handlers.tracer_progress({ type: "tracer_progress", current: 3, pos: 3, state: "paused", reason: null, rx: null });
  expect(store.toasts.value).toEqual([]);
  handlers.tracer_progress({
    type: "tracer_progress",
    current: 7,
    pos: 7,
    state: "paused",
    reason: "rx",
    rx: { ch: 2, id: 0x7e8, ext: false },
  });
  expect(store.toasts.value.map((x) => x.message)).toEqual([
    "Воспроизведение на паузе: получены данные (канал 2, ID 7E8) — включено «Остановить при получении данных»",
  ]);
  expect(tracerPause.value).toEqual({ reason: "rx", rx: { ch: 2, id: 0x7e8, ext: false } });
  handlers.tracer_progress({ type: "tracer_progress", current: 8, pos: 8, state: "playing", reason: null, rx: null });
  expect(tracerPause.value).toBeNull();
});
