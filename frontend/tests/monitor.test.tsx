// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const calls: { type: string; args: Record<string, unknown> }[] = [];
vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: (type: string, args: Record<string, unknown> = {}) => {
    calls.push({ type, args });
    return Promise.resolve({});
  },
}));

import { dialog } from "../src/app/ui";
import { clearActions, runAction } from "../src/core/actions";
import { resetStore } from "../src/core/store";
import { MonitorPanel, ingestMonitorRows, monitorSelection, monitorStore } from "../src/features/monitor/MonitorGrid";
import { registerMonitorActions } from "../src/features/monitor/actions";

function DialogHost() {
  return <>{dialog.value}</>;
}

beforeEach(() => {
  resetStore();
  clearActions();
  monitorStore.reset();
  calls.length = 0;
});
afterEach(() => cleanup());

test("F4 opens comment dialog for selected row and sends comment_set", async () => {
  render(
    <>
      <MonitorPanel />
      <DialogHost />
    </>,
  );
  registerMonitorActions();
  ingestMonitorRows([
    { ch: 1, id: 0x123, ext: false, rtr: false, fd: false, brs: false, dlc: 2, data: "0102", count: 3, period_ms: 20,
      changed: 3, stable_ms: [null, null], fc: 0, ts: 1 },
  ]);
  const cell = await screen.findByText("123");
  fireEvent.mouseDown(cell);
  expect(monitorSelection.value?.id).toBe(0x123);
  runAction("comment");
  const input = await screen.findByLabelText("Комментарий:");
  fireEvent.input(input, { target: { value: "кнопка руля" } });
  fireEvent.click(screen.getByText("Принять"));
  expect(calls).toContainEqual({ type: "comment_set", args: { id: 0x123, ext: false, text: "кнопка руля" } });
});
