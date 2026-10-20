// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: () => Promise.resolve({}),
}));

import { applyEvent, resetStore } from "../src/core/store";
import { ingestMonitorRows, monitorStore } from "../src/features/monitor/MonitorGrid";
import { SplitMonitor } from "../src/features/monitor/SplitMonitor";

const row = (ch: number, id: number) => ({
  ch, id, ext: false, rtr: false, fd: false, brs: false, dlc: 1, data: "01", count: 1, period_ms: null,
  changed: 0, stable_ms: [null], fc: 0, ts: 0,
});

beforeEach(() => {
  resetStore();
  monitorStore.reset();
});
afterEach(() => cleanup());

test("split shows one grid per channel with rows filtered", async () => {
  applyEvent({
    type: "status", state: "opened", message: "", device_info: null,
    channels: {
      "1": { open: true, alias: "Кузов", bitrate: 500000, timing: null, listen_only: false, terminator: false, error: null },
      "2": { open: true, alias: "", bitrate: 125000, timing: null, listen_only: false, terminator: false, error: null },
    },
  });
  render(<SplitMonitor />);
  ingestMonitorRows([row(1, 0x120), row(2, 0x3fb), row(1, 0x200)]);
  expect(await screen.findByText("Канал 1: Кузов")).toBeTruthy();
  expect(screen.getByText("Канал 2")).toBeTruthy();
  const g1 = screen.getByRole("grid", { name: "Канал 1: Кузов" });
  const g2 = screen.getByRole("grid", { name: "Канал 2" });
  expect(within(g1).getByText("120")).toBeTruthy();
  expect(within(g1).queryByText("3FB")).toBeNull();
  expect(within(g2).getByText("3FB")).toBeTruthy();
});
