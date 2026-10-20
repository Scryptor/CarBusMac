// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const calls: { type: string; args: Record<string, unknown> }[] = [];
const replies: Record<string, unknown> = {};
vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: (type: string, args: Record<string, unknown> = {}) => {
    calls.push({ type, args });
    return Promise.resolve(replies[type] ?? {});
  },
}));

import { MainMenu } from "../src/app/MainMenu";
import { closeDialog, dialog } from "../src/app/ui";
import { BreakpointsDialog } from "../src/features/tracer/BreakpointsDialog";
import { MainToolbar } from "../src/app/MainToolbar";
import { StatusBar } from "../src/app/StatusBar";
import { ui } from "../src/app/ui";
import { clearActions, registerActions, runAction } from "../src/core/actions";
import { installHotkeys } from "../src/core/hotkeys";
import { applyEvent, resetStore } from "../src/core/store";
import { shellActions } from "../src/app/shellActions";
import { registerTracer } from "../src/features/tracer/register";
import { TracerView } from "../src/features/tracer/TracerView";
import { syncTracerRev, tracerCache, tracerSel, tracerSelVersion, tracerVersion } from "../src/features/tracer/tracerStore";

const STATE = {
  type: "tracer_state",
  name: "drive.trc",
  modified: false,
  count: 6,
  visible: 5,
  channels: [1],
  rev: 3,
  state: "stopped",
  current: null,
  pos: null,
  config: {
    delay_mode: "timestamp",
    fixed_ms: 100,
    max_1s: false,
    loop: false,
    dest: "ch1",
    only_channel: null,
    stop_on_bp: true,
    stop_on_rx: false,
  },
  breakpoints: [],
};

beforeEach(() => {
  resetStore();
  calls.length = 0;
  clearActions();
  registerActions(shellActions());
  registerActions([{ id: "clear", label: "Сбросить полученные данные", scope: "main", run: () => {} }]);
  registerTracer();
  applyEvent(STATE);
  syncTracerRev(3);
  ui.view.value = "tracer";
  ui.tracerPlaySelected.value = false;
  tracerSel.clear();
  replies.tracer_ids = {
    ids: [
      { ch: 1, id: 0x100, ext: false, count: 5, enabled: true },
      { ch: 1, id: 0x200, ext: false, count: 1, enabled: false },
    ],
  };
});
afterEach(() => {
  cleanup();
  ui.view.value = "main";
});

const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k }));

test("play sends selection when play-selected on", () => {
  ui.tracerPlaySelected.value = true;
  tracerSel.click(1);
  tracerSel.shiftClick(3);
  runAction("tracerPlay");
  expect(calls).toContainEqual({ type: "tracer_play", args: { selection: [1, 2, 3] } });
});

test("play without play-selected plays the whole trace", () => {
  tracerSel.click(1);
  tracerSel.shiftClick(3);
  runAction("tracerPlay");
  expect(calls).toContainEqual({ type: "tracer_play", args: { selection: null } });
});

test("F9 toggles play/pause", () => {
  const off = installHotkeys(() => "tracer");
  try {
    key("F9");
    expect(calls.at(-1)?.type).toBe("tracer_play");
    applyEvent({ type: "tracer_progress", current: 0, pos: 0, state: "playing" });
    key("F9");
    expect(calls.at(-1)?.type).toBe("tracer_pause");
  } finally {
    off();
  }
});

test("step sends tracer_step", () => {
  const off = installHotkeys(() => "tracer");
  try {
    key("F8");
    expect(calls.at(-1)).toEqual({ type: "tracer_step", args: {} });
  } finally {
    off();
  }
});

test("tracer view shows the rows counter and the id table toggles an id", async () => {
  render(<TracerView />);
  expect(screen.getByText("Строк: 5 из 6")).toBeTruthy();
  const box = await screen.findByLabelText("Воспроизводить 200 (канал 1)");
  expect((box as HTMLInputElement).checked).toBe(false);
  fireEvent.click(box);
  expect(calls).toContainEqual({ type: "tracer_ids_set", args: { keys: [[1, 0x200, false]], enabled: true } });
});

test("options row edits the player config", () => {
  render(<TracerView />);
  fireEvent.click(screen.getByLabelText("Остановить при получении данных"));
  expect(calls).toContainEqual({ type: "tracer_config", args: { patch: { stop_on_rx: true } } });
});

test("tracer view has its own menus, toolbar and status", () => {
  render(
    <>
      <MainMenu />
      <MainToolbar />
      <StatusBar />
    </>,
  );
  expect(screen.getByRole("button", { name: "Трейс" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Комментарий" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Файл" })).toBeNull();
  expect(screen.getByRole("button", { name: "Один шаг отправки" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Сбросить полученные данные" })).toBeNull();
  expect(screen.getByText("Передача в канал 1")).toBeTruthy();
  expect(screen.getByText("Пауза: Авто")).toBeTruthy();
});

const trow = (pos: number, i = pos) => ({
  i,
  pos,
  t: 0,
  ch: 1,
  dir: "rx" as const,
  id: 0x321,
  ext: false,
  rtr: false,
  dlc: 1,
  data: "05",
  marker: null,
  enabled: true,
  bp: false,
  start: false,
  finish: false,
  before_ms: 0,
  after_ms: 0,
  comment: "",
});

test("breakpoint works on the cursor row even before its data is loaded", () => {
  tracerCache.reset();
  tracerSel.click(4);
  tracerSelVersion.value++;
  expect(runAction("tracerBp")).toBe(true);
  expect(calls).toContainEqual({ type: "tracer_bp", args: { pos: 4 } });
});

test("copy to TX-List fetches the cursor row when it is not cached", async () => {
  tracerCache.reset();
  tracerSel.click(2);
  tracerSelVersion.value++;
  replies.tracer_rows = { rev: 3, data_rev: 0, rows: [trow(2, 7)] };
  expect(runAction("tracerCopyTx")).toBe(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(calls.some((c) => c.type === "tracer_rows" && c.args.start === 2 && c.args.count === 1)).toBe(true);
});

test("status shows the cursor row once its data arrives", async () => {
  tracerCache.reset();
  tracerSel.click(1);
  tracerSelVersion.value++;
  render(<StatusBar />);
  expect(screen.getByText("Текущая строка: 0 / Выделено: 0")).toBeTruthy();
  tracerCache.put(1, [trow(1, 41)]);
  tracerVersion.value++;
  expect(await screen.findByText("Текущая строка: 42 / Выделено: 0")).toBeTruthy();
});

function withHotkeys(fn: () => void | Promise<void>) {
  const off = installHotkeys(() => "tracer");
  return Promise.resolve(fn()).finally(off);
}
const keyEv = (k: string, mods: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, ...mods }));

test("Ins opens the add-row editor and Ctrl+Enter edits the cursor row", () =>
  withHotkeys(async () => {
    keyEv("Insert");
    await new Promise((r) => setTimeout(r, 0));
    render(dialog.value!);
    expect(screen.getByRole("dialog", { name: "Добавить строку" })).toBeTruthy();
    cleanup();
    closeDialog();
    tracerCache.put(2, [trow(2, 9)]);
    tracerSel.click(2);
    tracerSelVersion.value++;
    keyEv("Enter", { ctrlKey: true });
    await new Promise((r) => setTimeout(r, 0));
    render(dialog.value!);
    expect(screen.getByRole("dialog", { name: "Отредактировать строку" })).toBeTruthy();
    expect((screen.getByLabelText("ID") as HTMLInputElement).value).toBe("321");
    closeDialog();
  }));

test("Ctrl+Del deletes the cursor row and disable-by-ID uses its key", () =>
  withHotkeys(async () => {
    tracerCache.put(3, [trow(3)]);
    tracerSel.click(3);
    tracerSelVersion.value++;
    keyEv("Delete", { ctrlKey: true });
    expect(calls).toContainEqual({ type: "tracer_rows_delete", args: { positions: [3] } });
    runAction("tracerDisableById");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContainEqual({ type: "tracer_rows_enable", args: { key: [1, 0x321, false], enabled: false } });
    runAction("tracerStart");
    expect(calls).toContainEqual({ type: "tracer_bounds", args: { which: "start", pos: 3 } });
  }));

test("Ctrl+C copies the selected rows as TSV", () =>
  withHotkeys(async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    tracerCache.put(0, [trow(0), trow(1)]);
    tracerSel.click(0);
    tracerSel.shiftClick(1);
    tracerSelVersion.value++;
    keyEv("c", { ctrlKey: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalledWith("№\tВремя\tCH\tID\tDLC\tДанные\tКомментарий\n1\t0,000\t1\t321\t1\t05\t\n2\t0,000\t1\t321\t1\t05\t\n");
  }));

test("breakpoints list jumps to a visible breakpoint", async () => {
  applyEvent({ ...STATE, breakpoints: [{ i: 5, pos: 4 }, { i: 9, pos: null }] });
  replies.tracer_rows = { rev: 3, data_rev: 0, rows: [trow(4, 5)] };
  render(<BreakpointsDialog />);
  expect(await screen.findByText("скрыта фильтром ID")).toBeTruthy();
  fireEvent.click(await screen.findByText("6"));
  fireEvent.click(screen.getByRole("button", { name: "Перейти" }));
  expect(tracerSel.focus).toBe(4);
});
