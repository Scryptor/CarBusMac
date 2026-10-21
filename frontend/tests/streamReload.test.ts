import { expect, test, vi } from "vitest";

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
import { fetchRange, streamCache } from "../src/features/stream/StreamGrid";

const row = (i: number) => ({ i, t: i / 100, ch: 1, dir: "rx" as const, id: 0x100, ext: false, rtr: false, dlc: 1, data: "01", marker: null });

test("stream rows load after a page reload: the hello snapshot carries the capture revision", async () => {
  resetStore();
  handlers.hello({ type: "hello", capture: { rev: 4 } });
  applyEvent({ type: "capture_state", recording: false, count: 2, duration_s: 0, full: false, rev: 4, markers: [] });
  replies.capture_rows = { rev: 4, rows: [row(0), row(1)] };
  fetchRange(0, 2);
  await new Promise((r) => setTimeout(r, 0));
  expect(streamCache.get(1)?.i).toBe(1);
});

const many = (n: number) => Array.from({ length: n }, (_, i) => row(i));

test("the stream cache stays bounded: rows far from the visible area are dropped", () => {
  resetStore();
  handlers.hello({ type: "hello", capture: { rev: 6 } });
  applyEvent({ type: "capture_state", recording: true, count: 30000, duration_s: 10, full: false, rev: 6, markers: [] });
  streamCache.put(0, many(30000));
  fetchRange(29950, 30000);
  expect(streamCache.size).toBeLessThanOrEqual(30000 - (29950 - 2000));
  expect(streamCache.get(29990)?.i).toBe(29990);
});

test("without an open stream table the tail is not accumulated", () => {
  resetStore();
  handlers.hello({ type: "hello", capture: { rev: 7 } });
  for (let k = 0; k < 5; k++) {
    handlers.capture_tail({ type: "capture_tail", count: (k + 1) * 100, duration_s: k, rev: 7, start: k * 100, rows: many(100) });
  }
  expect(streamCache.size).toBe(0); // режим «Монитор»: строки живут на бэкенде, таблица подгрузит их сама
});
