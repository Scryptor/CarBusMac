// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
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
import { clearActions, getAction, registerActions, runAction } from "../src/core/actions";
import { installHotkeys } from "../src/core/hotkeys";
import { applyEvent, resetStore, store } from "../src/core/store";
import { shellActions } from "../src/app/shellActions";
import { CustomDelayDialog } from "../src/features/tracer/CustomDelayDialog";
import { delayMenuItems, destMenuItems } from "../src/features/tracer/DelayMenu";
import { registerTracer } from "../src/features/tracer/register";
import { RowEditorDialog } from "../src/features/tracer/RowEditorDialog";
import { tracerMenu } from "../src/features/tracer/TracerGrid";
import { TracerView } from "../src/features/tracer/TracerView";
import { syncTracerRev, tracerCache, tracerSel, tracerSelVersion, tracerVersion } from "../src/features/tracer/tracerStore";
import type { MenuItem } from "../src/ui/Menu";

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
  expect(screen.getByRole("button", { name: "Шаг" })).toBeTruthy();
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
  expect(screen.getByText("Текущая строка: —")).toBeTruthy();
  tracerCache.put(1, [trow(1, 41)]);
  tracerVersion.value++;
  expect(await screen.findByText("Текущая строка: 42")).toBeTruthy();
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

test("«Сохранить как» for a .jsonl trace offers .jsonl, not the default .trc", async () => {
  replies.files_list = { files: [] };
  applyEvent({ ...STATE, name: "drive.jsonl" });
  expect(runAction("tracerSaveAs")).toBe(true);
  render(dialog.value!);
  expect(((await screen.findByLabelText("Формат")) as HTMLSelectElement).value).toBe("jsonl");
  expect((screen.getByLabelText("Имя файла") as HTMLInputElement).value).toBe("drive");
  fireEvent.click(screen.getByText("Сохранить", { selector: "button" }));
  expect(calls).toContainEqual({ type: "tracer_save", args: { name: "drive", format: "jsonl" } });
  closeDialog();
});

test("step from stop goes through the selection when play-selected is on", () => {
  ui.tracerPlaySelected.value = true;
  tracerSel.click(1);
  tracerSel.shiftClick(3);
  expect(runAction("tracerStep")).toBe(true);
  expect(calls.at(-1)).toEqual({ type: "tracer_step", args: { selection: [1, 2, 3] } });
  // на паузе шаг продолжает начатый прогон — выделение уже у сервера
  applyEvent({ type: "tracer_progress", current: 2, pos: 2, state: "paused" });
  expect(runAction("tracerStep")).toBe(true);
  expect(calls.at(-1)).toEqual({ type: "tracer_step", args: {} });
});

test("«Только для канала» stays editable while a channel is chosen that the trace does not have", () => {
  applyEvent({ ...STATE, channels: [1], config: { ...STATE.config, only_channel: 2 } });
  render(<TracerView />);
  const select = screen.getByLabelText("Только для канала:") as HTMLSelectElement;
  expect(select.disabled).toBe(false);
  expect(select.value).toBe("2"); // видно, что выбрано сейчас
  fireEvent.change(select, { target: { value: "" } });
  expect(calls).toContainEqual({ type: "tracer_config", args: { patch: { only_channel: null } } });
  cleanup();
  applyEvent({ ...STATE, channels: [1] }); // одноканальный трейс без выбора — выбирать нечего
  render(<TracerView />);
  expect((screen.getByLabelText("Только для канала:") as HTMLSelectElement).disabled).toBe(true);
});

test("the trace table repaints a selection changed from outside it", () => {
  tracerCache.put(0, [trow(0), trow(1), trow(2)]);
  render(<TracerView />);
  const selected = () => [...document.querySelectorAll('[aria-label="Отладчик"] .gr.sel')].map((r) => r.getAttribute("aria-rowindex"));
  expect(selected()).toEqual([]);
  act(() => {
    tracerSel.click(1); // например, «Выделить сообщения» в таблице ID
    tracerSel.addMany([2]);
    tracerSelVersion.value++;
  });
  expect(selected()).toEqual(["2", "3"]);
  act(() => void runAction("tracerCancelSel"));
  expect(selected()).toEqual([]);
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const labelOf = (items: MenuItem[], action: string) =>
  items.some((m) => "action" in m && m.action === action) ? getAction(action)?.label : undefined;

const listenOnly = {
  type: "status",
  state: "opened",
  message: "",
  device: null,
  device_info: { hardware_name: "HW_CH32", firmware_version: "2.2.3.57", serial_int: 6950 },
  log: "2026-10-21_13-01-20.trc",
  channels: {
    "1": { open: true, alias: "", bitrate: 500000, timing: null, listen_only: true, terminator: false, error: null },
    "2": { open: false, alias: "", bitrate: 500000, timing: null, listen_only: false, terminator: false, error: null },
  },
};

test("tracer status on a narrow screen: destination and progress never shrink, device status yields first", () => {
  applyEvent(listenOnly);
  render(<StatusBar />);
  const cell = (text: string) => screen.getByText(text).closest(".cell") as HTMLElement;
  // куда уйдёт трейс и прогресс — keep: не сжимаются никогда
  expect(cell("Передача в канал 1").classList.contains("keep")).toBe(true);
  expect(screen.getByRole("progressbar").closest(".cell")!.classList.contains("keep")).toBe(true);
  // прибор в виде отладчика — только в подсказке к состоянию связи
  expect(screen.queryByText("HW_CH32 2.2.3.57 №6950")).toBeNull();
  expect(cell("Подключено").title).toContain("HW_CH32 2.2.3.57 №6950");
  // фоновая запись — коротко, уступает место первой; имя файла — в подсказке
  const log = cell("Фоновая запись");
  expect(log.classList.contains("soft")).toBe(true);
  expect(log.title).toBe("Фоновая запись: 2026-10-21_13-01-20.trc");
  expect(screen.getByText("Текущая строка: —")).toBeTruthy(); // без «/ Выделено: 0»
  // каналы уступают место раньше ячеек отладчика, полный текст — в подсказке
  expect(cell("К1: 500k, только прослушивание").classList.contains("soft")).toBe(true);
  expect(cell("К1: 500k, только прослушивание").title).toBe("К1: 500k, только прослушивание");
  expect(cell("Текущая строка: —").classList.contains("soft")).toBe(false);
  cleanup();
  ui.view.value = "main"; // в главном окне — как было
  render(<StatusBar />);
  expect(screen.getByText("HW_CH32 2.2.3.57 №6950")).toBeTruthy();
  expect(cell("К1: 500k, только прослушивание").classList.contains("soft")).toBe(false);
  expect(screen.getByText("Фоновая запись: 2026-10-21_13-01-20.trc")).toBeTruthy();
});

test("the trace table keeps its scroll across F12 → F12", () => {
  applyEvent({ ...STATE, count: 3000, visible: 3000 });
  const view = render(<TracerView />);
  const grid = () => screen.getByRole("grid", { name: "Отладчик" });
  grid().scrollTop = 22 * 1500;
  fireEvent.scroll(grid());
  view.unmount(); // F12 — в главное окно: вид размонтируется
  render(<TracerView />); // F12 — обратно
  expect(grid().scrollTop).toBe(22 * 1500);
  grid().scrollTop = 0; // запомненная прокрутка — общая для вида: вернуть как было
  fireEvent.scroll(grid());
});

test("back in the tracer the table shows where playback got to while the view was closed", async () => {
  applyEvent({ ...STATE, count: 3000, visible: 3000 });
  const grid = () => screen.getByRole("grid", { name: "Отладчик" });
  const view = render(<TracerView />);
  fireEvent.scroll(grid()); // таблица в начале
  view.unmount();
  applyEvent({ type: "tracer_progress", current: 2000, pos: 2000, state: "paused" }); // встал на точке останова
  render(<TracerView />);
  await act(async () => {
    await tick();
  });
  expect(grid().scrollTop).toBeGreaterThan(2000 * 22 - 1000);
  grid().scrollTop = 0;
  fireEvent.scroll(grid());
});

test("Ctrl+Del moves the cursor to the next row, so it can be pressed again", () =>
  withHotkeys(async () => {
    applyEvent({ ...STATE, count: 10, visible: 10 });
    tracerSel.click(3);
    tracerSelVersion.value++;
    replies.tracer_rows_delete = { rev: 4, pos: 3 };
    keyEv("Delete", { ctrlKey: true });
    syncTracerRev(4); // tracer_state с новой ревизией: позиции сдвинулись, выделение сброшено
    applyEvent({ ...STATE, rev: 4, count: 9, visible: 9 });
    await tick();
    expect(tracerSel.focus).toBe(3);
    keyEv("Delete", { ctrlKey: true });
    expect(calls.filter((c) => c.type === "tracer_rows_delete").map((c) => c.args)).toEqual([{ positions: [3] }, { positions: [3] }]);
  }));

test("an inserted row becomes the cursor", async () => {
  replies.tracer_row_add = { index: 3, pos: 3, rev: 5 };
  render(<RowEditorDialog mode="insert" base={trow(2)} />);
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await tick();
  expect(calls).toContainEqual({ type: "tracer_row_add", args: expect.objectContaining({ after: 2 }) });
  syncTracerRev(5); // tracer_state пришёл после ответа
  expect(tracerSel.focus).toBe(3);
});

test("copy to TX-List from the tracer confirms with a toast", async () => {
  tracerCache.put(2, [trow(2, 7)]);
  tracerSel.click(2);
  tracerSelVersion.value++;
  expect(runAction("tracerCopyTx")).toBe(true);
  await tick();
  expect(calls.some((c) => c.type === "tx_upsert")).toBe(true);
  expect(store.toasts.value.at(-1)?.message).toBe("Скопировано в TX-List: 321");
});

test("the cursor row and the playback row are named apart", () => {
  tracerCache.put(0, [trow(0), trow(1), trow(2)]);
  tracerSel.click(1);
  tracerSelVersion.value++;
  applyEvent({ ...STATE, state: "paused", current: 2, pos: 2 });
  render(
    <>
      <TracerView />
      <StatusBar />
    </>,
  );
  expect(screen.getByText("Текущая строка: 2")).toBeTruthy(); // курсор — как rsTraceActiveRow
  expect(screen.getByText("Для отладки: 3")).toBeTruthy(); // строка воспроизведения — rsTraceNextRow
  const mark = screen.getByLabelText("Строка для отладки");
  expect(mark.closest('[role="row"]')?.getAttribute("aria-rowindex")).toBe("3");
  act(() => {
    tracerSel.ctrlClick(0);
    tracerSelVersion.value++;
  });
  expect(screen.getByText("Текущая строка: 1 / Выделено: 2")).toBeTruthy();
});

test("the breakpoints list has column headers", async () => {
  applyEvent({ ...STATE, breakpoints: [{ i: 5, pos: 4 }] });
  replies.tracer_rows = { rev: 3, data_rev: 0, rows: [trow(4, 5)] };
  render(<BreakpointsDialog />);
  expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["№", "Время", "CH", "ID", "Данные"]);
  expect(await screen.findByText("321")).toBeTruthy();
});

test("the custom pause dialog names the range once", () => {
  render(<CustomDelayDialog />);
  fireEvent.input(screen.getByLabelText("Пауза (10 - 9999)"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Установить" }));
  expect(screen.getByText("Пауза, мс: от 10 до 9999")).toBeTruthy();
  expect(calls.some((c) => c.type === "tracer_config")).toBe(false);
});

test("captions follow the desktop's Russian.lng", () => {
  const menu = tracerMenu();
  expect(labelOf(menu, "tracerDisableSel")).toBe("Запретить выделенное"); // acDisableSelected
  expect(labelOf(menu, "tracerEnableSel")).toBe("Разрешить выделенное"); // acEnableSelected
  expect(labelOf(menu, "tracerCopyTx")).toBe("Копировать в TX-List"); // tbCopy
  expect(delayMenuItems()[0]).toMatchObject({ label: "Пауза между сообщениями по умолчанию" }); // miClockAuto
  expect(destMenuItems().map((m) => ("label" in m ? m.label : ""))).toEqual(["Канал 1", "Канал 2", "В монитор"]); // pmTransmit
  expect(getAction("tracerStep")?.label).toBe("Шаг"); // acStep
  expect(getAction("tracerLoop")?.label).toBe("Повторять"); // acLoop
  expect(getAction("tracerPlaySel")?.label).toBe("Разрешить запуск выделенного"); // acPlaySelected
  render(<MainToolbar />);
  expect(screen.getByRole("button", { name: /^Пауза между отправкой сообщений/ })).toBeTruthy(); // tbDelay
  cleanup();
  render(<RowEditorDialog mode="edit" base={trow(2)} onSubmit={() => {}} onClose={() => {}} />); // TdlgTracerRow
  for (const text of ["Пауза (мс)", "Перед", "После"]) expect(screen.getByText(text)).toBeTruthy(); // gbOptions
  // группы — в порядке десктопа: gbMessage, gbFlags, gbOptions, gbData
  expect([...document.querySelectorAll(".group > .group-title")].map((g) => g.textContent)).toEqual(["Сообщение", "Флаги", "Опции", "Сырые данные"]);
});

test("a trace row's own comment is edited from the table's context menu", async () => {
  tracerCache.put(2, [{ ...trow(2, 7), comment: "старый" }]);
  tracerSel.click(2);
  tracerSelVersion.value++;
  expect(labelOf(tracerMenu(), "tracerRowComment")).toBe("Комментарий строки…");
  expect(runAction("tracerRowComment")).toBe(true);
  await tick();
  render(dialog.value!);
  expect(screen.getByRole("dialog", { name: "Изменить комментарий для строки 8" })).toBeTruthy();
  const input = screen.getByLabelText("Комментарий:") as HTMLInputElement;
  expect(input.value).toBe("старый");
  fireEvent.input(input, { target: { value: "новый" } });
  fireEvent.click(screen.getByRole("button", { name: "Установить" }));
  expect(calls).toContainEqual({ type: "tracer_comment", args: { pos: 2, text: "новый" } });
  closeDialog();
});
