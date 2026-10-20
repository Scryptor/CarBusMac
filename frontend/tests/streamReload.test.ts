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

const row = (i: number) => ({ i, t: i / 100, ch: 1, dir: "rx", id: 0x100, ext: false, rtr: false, dlc: 1, data: "01", marker: null });

test("stream rows load after a page reload: the hello snapshot carries the capture revision", async () => {
  resetStore();
  handlers.hello({ type: "hello", capture: { rev: 4 } });
  applyEvent({ type: "capture_state", recording: false, count: 2, duration_s: 0, full: false, rev: 4, markers: [] });
  replies.capture_rows = { rev: 4, rows: [row(0), row(1)] };
  fetchRange(0, 2);
  await new Promise((r) => setTimeout(r, 0));
  expect(streamCache.get(1)?.i).toBe(1);
});
