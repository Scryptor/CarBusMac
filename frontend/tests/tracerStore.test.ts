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

import { applyEvent, resetStore } from "../src/core/store";
import type { PlayerConfig, TracerRowJson } from "../src/core/types";
import {
  delayText,
  destText,
  fetchTracerRange,
  idKey,
  selectionPayload,
  syncTracerRev,
  tracerCache,
  tracerSel,
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
  expect(destText({ ...cfg, dest: "monitor" })).toBe("Передача в окно Приём");
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
