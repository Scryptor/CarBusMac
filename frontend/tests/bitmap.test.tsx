// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: () => Promise.resolve({ rows: [] }),
}));

import { floats } from "../src/app/ui";
import { resetStore } from "../src/core/store";
import { openBitmap } from "../src/features/monitor/BitmapWindow";
import { ingestMonitorRows, monitorStore } from "../src/features/monitor/MonitorGrid";

function Floats() {
  return <>{[...floats.value.values()]}</>;
}

const row = (ch: number, id: number, data: string) => ({
  ch, id, ext: false, rtr: false, fd: false, brs: false, dlc: data.length / 2, data, count: 1, period_ms: null,
  changed: 0, stable_ms: [], fc: 0, ts: 0,
});

beforeEach(() => {
  resetStore();
  monitorStore.reset();
  floats.value = new Map();
});
afterEach(() => cleanup());

test("multiple windows keyed by message", async () => {
  render(<Floats />);
  ingestMonitorRows([row(1, 0x120, "0e0062aa"), row(2, 0x3fb, "0c")]);
  openBitmap(1, 0x120, false);
  openBitmap(2, 0x3fb, false);
  openBitmap(1, 0x120, false); // повторно — то же окно
  expect(floats.value.size).toBe(2);
  expect(await screen.findByText("[1] 120: Детали сообщения")).toBeTruthy();
  expect(screen.getByText("[2] 3FB: Детали сообщения")).toBeTruthy();
});

test("bitmap shows bits MSB first and decimal value", async () => {
  render(<Floats />);
  ingestMonitorRows([row(1, 0x120, "0e0062aa")]);
  openBitmap(1, 0x120, false);
  const win = await screen.findByRole("dialog", { name: "[1] 120: Детали сообщения" });
  expect(win.textContent).toContain("x80");
  expect(win.textContent).toContain("170"); // 0xAA
  const byte3 = win.querySelector('[data-byte="3"]')!;
  expect([...byte3.querySelectorAll(".bit")].map((b) => b.textContent).join("")).toBe("10101010");
});
