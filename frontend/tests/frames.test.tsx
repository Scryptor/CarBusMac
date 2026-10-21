// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] as { type: string; args: Record<string, unknown> }[] }));
vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: (type: string, args: Record<string, unknown> = {}) => {
    calls.push({ type, args });
    if (type === "monitor_frames") {
      return Promise.resolve({ rows: [{ data: "0102", count: 3, period_ms: 20, ts: 1 }, { data: "0103", count: 1, period_ms: null, ts: 2 }] });
    }
    return Promise.resolve({});
  },
}));

import { closeDialog, dialog, floats } from "../src/app/ui";
import { clearActions, registerActions } from "../src/core/actions";
import { installHotkeys } from "../src/core/hotkeys";
import { applyEvent, resetStore } from "../src/core/store";
import { registerMonitorActions } from "../src/features/monitor/actions";
import { openFrames } from "../src/features/monitor/FramesWindow";
import { ingestMonitorRows, monitorSelection, monitorStore } from "../src/features/monitor/MonitorGrid";
import { transmitActions } from "../src/features/transmit/actions";

function Host() {
  return (
    <>
      {[...floats.value.values()]}
      {dialog.value}
    </>
  );
}

const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  resetStore();
  clearActions();
  registerMonitorActions();
  registerActions(transmitActions());
  monitorStore.reset();
  floats.value = new Map();
  calls.length = 0;
  applyEvent({ type: "settings", settings: { aggregator: true } });
  applyEvent({ type: "comments", comments: { "291:0": "кнопка руля" } });
});
afterEach(() => {
  cleanup();
  closeDialog();
  monitorSelection.value = null;
});

test("the message data window shows the message comment and edits it by the button and by F4", async () => {
  render(<Host />);
  act(() => openFrames(1, 0x123, false));
  const win = await screen.findByRole("dialog", { name: "[1] 123: Данные сообщения" });
  await tick();
  expect(win.textContent).toContain("кнопка руля");
  const btn = within(win).getByRole("button", { name: "Установить комментарий" });
  expect(btn.title).toBe("Установить комментарий для выбранного сообщения (F4)");
  fireEvent.click(btn);
  expect(screen.getByRole("dialog", { name: "Изменить комментарий для 123" })).toBeTruthy();
  act(() => closeDialog());
  // F4, пока фокус в окне, — комментарий этого сообщения, а не выделенного в мониторе
  ingestMonitorRows([{ ch: 2, id: 0x3fb, ext: false, rtr: false, fd: false, brs: false, dlc: 1, data: "0c", count: 1,
    period_ms: null, changed: 0, stable_ms: [], fc: 0, ts: 0 }]);
  monitorSelection.value = monitorStore.get("2:1019:0") ?? null;
  const off = installHotkeys(() => "main");
  try {
    const grid = within(win).getByRole("grid");
    grid.focus();
    act(() => void fireEvent.keyDown(grid, { key: "F4" }));
    expect(screen.getByRole("dialog", { name: "Изменить комментарий для 123" })).toBeTruthy();
  } finally {
    off();
  }
});

test("«Копировать в TX-List» in the window copies the payload picked there", async () => {
  render(<Host />);
  act(() => openFrames(1, 0x123, false));
  const win = await screen.findByRole("dialog", { name: "[1] 123: Данные сообщения" });
  await tick();
  const copy = within(win).getByRole("button", { name: "Копировать в TX-List" }) as HTMLButtonElement;
  expect(copy.disabled).toBe(true);
  fireEvent.mouseDown(within(win).getAllByText("03")[0]);
  expect(copy.disabled).toBe(false);
  fireEvent.click(copy);
  await tick();
  const up = calls.find((c) => c.type === "tx_upsert")?.args.task as { can_id: number; data: string; comment: string };
  expect([up.can_id, up.data, up.comment]).toEqual([0x123, "0103", "кнопка руля"]);
});
