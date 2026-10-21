// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { calls, fail, replies } = vi.hoisted(() => ({
  calls: [] as { type: string; args: Record<string, unknown> }[],
  fail: {} as Record<string, string>,
  replies: {} as Record<string, unknown>,
}));
vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: (type: string, args: Record<string, unknown> = {}) => {
    calls.push({ type, args });
    return fail[type] ? Promise.reject(new Error(fail[type])) : Promise.resolve(replies[type] ?? {});
  },
}));

import { dialog } from "../src/app/ui";
import { applyEvent, resetStore, store } from "../src/core/store";
import type { TxTaskJson } from "../src/core/types";
import { transmitActions } from "../src/features/transmit/actions";
import { TransmitDock, txApi, txSelected } from "../src/features/transmit/TransmitDock";
import { EMPTY8, newTask } from "../src/features/transmit/txModel";

beforeEach(() => {
  resetStore();
  calls.length = 0;
  for (const k of Object.keys(fail)) delete fail[k];
  for (const k of Object.keys(replies)) delete replies[k];
  txSelected.value = null;
});
afterEach(() => cleanup());

test("Enter in editor sends tx_send for the selected task", async () => {
  applyEvent({ type: "tx_state", tasks: [{ ...newTask("t1"), can_id: 0x7e0, data: "023e00" }] });
  render(<TransmitDock />);
  fireEvent.mouseDown(await screen.findByText("7E0"));
  const id = screen.getByLabelText("ID") as HTMLInputElement;
  expect(id.value).toBe("7E0");
  fireEvent.keyDown(id, { key: "Enter" });
  await new Promise((r) => setTimeout(r, 0));
  expect(calls.some((c) => c.type === "tx_send" && c.args.id === "t1")).toBe(true);
});

test("editing a field upserts the task after validation", async () => {
  applyEvent({ type: "tx_state", tasks: [{ ...newTask("t1"), can_id: 0x100 }] });
  render(<TransmitDock />);
  fireEvent.mouseDown(await screen.findByText("100"));
  const id = screen.getByLabelText("ID");
  fireEvent.input(id, { target: { value: "800" } });
  await new Promise((r) => setTimeout(r, 400));
  expect(calls.some((c) => c.type === "tx_upsert")).toBe(false);
  expect(id.getAttribute("aria-invalid")).toBe("true");
  fireEvent.input(id, { target: { value: "321" } });
  await new Promise((r) => setTimeout(r, 400));
  const up = calls.find((c) => c.type === "tx_upsert");
  expect((up?.args.task as { can_id: number }).can_id).toBe(0x321);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const upserts = () => calls.filter((c) => c.type === "tx_upsert").map((c) => c.args.task as TxTaskJson);
const comment = () => screen.getByLabelText("Комментарий") as HTMLInputElement;

function twoTasks() {
  applyEvent({
    type: "tx_state",
    tasks: [
      { ...newTask("t1"), can_id: 0x100 },
      { ...newTask("t2"), can_id: 0x200 },
    ],
  });
  render(<TransmitDock />);
}

test("an edit followed by «Удалить» within 300 ms does not bring the task back", async () => {
  twoTasks();
  fireEvent.mouseDown(await screen.findByText("100"));
  fireEvent.input(comment(), { target: { value: "правка" } });
  fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
  await wait(400);
  expect(calls.some((c) => c.type === "tx_delete" && c.args.id === "t1")).toBe(true);
  expect(upserts().filter((x) => x.id === "t1")).toEqual([]);
});

test("editing A, clicking B and editing B quickly saves both edits", async () => {
  twoTasks();
  fireEvent.mouseDown(await screen.findByText("100"));
  fireEvent.input(comment(), { target: { value: "задача A" } });
  fireEvent.mouseDown(screen.getByText("200"));
  await wait(0);
  expect(comment().value).toBe("");
  fireEvent.input(comment(), { target: { value: "задача B" } });
  await wait(400);
  expect(upserts().map((x) => [x.id, x.comment])).toEqual([
    ["t1", "задача A"],
    ["t2", "задача B"],
  ]);
});

test("«Копировать» copies what is in the editor, including the unsaved edit", async () => {
  twoTasks();
  fireEvent.mouseDown(await screen.findByText("100"));
  fireEvent.input(comment(), { target: { value: "копия" } });
  fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
  await wait(0);
  const copy = upserts().find((x) => x.id === "t3");
  expect(copy?.comment).toBe("копия");
});

test("a double click in the table saves the pending edit before sending", async () => {
  twoTasks();
  fireEvent.mouseDown(await screen.findByText("100"));
  fireEvent.input(comment(), { target: { value: "перед отправкой" } });
  fireEvent.dblClick(screen.getByText("100"));
  await wait(0);
  const types = calls.map((c) => c.type);
  expect(types.indexOf("tx_upsert")).toBeGreaterThanOrEqual(0);
  expect(types.indexOf("tx_upsert")).toBeLessThan(types.indexOf("tx_send"));
  expect(upserts()[0].comment).toBe("перед отправкой");
});

test("«Добавить» with an error in the draft adds nothing and keeps the error", async () => {
  twoTasks();
  await screen.findByText("100");
  fireEvent.input(screen.getByLabelText("ID"), { target: { value: "800" } }); // 11 бит — не больше 7FF
  fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
  await wait(0);
  expect(upserts()).toEqual([]);
  expect(screen.getByRole("alert").textContent).not.toBe("");
});

test("a cycle that failed to start unticks its checkbox", async () => {
  twoTasks();
  fail.tx_start = "Нет подключения к устройству";
  const box = (await screen.findByLabelText("Старт/Пауза 100")) as HTMLInputElement;
  fireEvent.click(box);
  await wait(0);
  expect(calls.some((c) => c.type === "tx_start")).toBe(true);
  expect(box.checked).toBe(false);
});

const startBtn = () => screen.getByRole("button", { name: "Старт" }) as HTMLButtonElement;

test("«Старт» without a selected task is unavailable and never starts the draft", async () => {
  twoTasks();
  await screen.findByText("100");
  expect(txSelected.value).toBe(null);
  expect(startBtn().disabled).toBe(true);
  fireEvent.click(startBtn());
  txApi.runPause?.(); // меню и хоткей Pause зовут то же действие
  await wait(0);
  expect(calls.map((c) => c.type)).toEqual([]); // ни задачи из черновика (ID 000, 10 мс), ни запуска
  fireEvent.mouseDown(screen.getByText("100"));
  expect(startBtn().disabled).toBe(false);
});

test("«Старт» is unavailable again once the list is cleared", async () => {
  twoTasks();
  fireEvent.mouseDown(await screen.findByText("100"));
  expect(startBtn().disabled).toBe(false);
  act(() => applyEvent({ type: "tx_state", tasks: [] })); // «Очистить список»
  expect(startBtn().disabled).toBe(true);
});

/** Клик мышью, как в браузере: без act — обработчики выполняются, а эффекты ждут кадра. */
async function rawMouseDown(el: Element) {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  for (let k = 0; k < 3; k++) await Promise.resolve(); // отрисовка (микрозадача), но не кадр
}

test("an edit right after clicking another task goes to that task, not a copy of the previous one", async () => {
  const trigger = { action: "start" as const, delay_ms: 5, channel: 2, can_id: 0x7e8, ext: false, dlc: null, data: EMPTY8() };
  applyEvent({
    type: "tx_state",
    tasks: [
      { ...newTask("t1"), can_id: 0x100, data: "11", comment: "A" },
      { ...newTask("t2"), can_id: 0x200, data: "2222", comment: "B", trigger },
    ],
  });
  render(<TransmitDock />);
  fireEvent.mouseDown(await screen.findByText("100"));
  expect(comment().value).toBe("A");
  // B выделена, и правка приходит раньше, чем выполнились бы эффекты (в браузере 20–50 мс)
  await rawMouseDown(screen.getByText("200"));
  expect(txSelected.value).toBe("t2");
  const c = comment();
  c.value = "B+";
  c.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(400);
  // B не стала копией A: её ID, данные и триггер на месте
  expect(upserts()).toEqual([{ ...newTask("t2"), can_id: 0x200, data: "2222", comment: "B+", trigger }]);
  expect((screen.getByLabelText("ID") as HTMLInputElement).value).toBe("200");
});

test("Enter in «Значение» fills the data and sends nothing", async () => {
  applyEvent({ type: "tx_state", tasks: [{ ...newTask("t1"), can_id: 0x7e0, data: "023e00" }] });
  render(<TransmitDock />);
  fireEvent.mouseDown(await screen.findByText("7E0"));
  const value = screen.getByLabelText("Значение");
  fireEvent.input(value, { target: { value: "AA" } });
  fireEvent.keyDown(value, { key: "Enter" });
  await wait(400);
  expect(calls.some((c) => c.type === "tx_send")).toBe(false);
  expect(upserts().map((x) => x.data)).toEqual(["aaaaaa"]);
  fireEvent.keyDown(screen.getByLabelText("Комментарий"), { key: "Enter" }); // вне поля Enter — «Послать»
  await wait(0);
  expect(calls.some((c) => c.type === "tx_send" && c.args.id === "t1")).toBe(true);
});

test("a bad «Значение» is highlighted until it is edited", async () => {
  twoTasks();
  fireEvent.mouseDown(await screen.findByText("100"));
  const value = screen.getByLabelText("Значение");
  fireEvent.input(value, { target: { value: "ZZ" } });
  fireEvent.click(screen.getByRole("button", { name: "Заполнить" }));
  expect(value.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByRole("alert").textContent).toContain("Значение");
  fireEvent.input(value, { target: { value: "0F" } });
  expect(value.getAttribute("aria-invalid")).toBe(null);
  expect(screen.getByRole("alert").textContent).toBe("");
});

test("«Добавить» with a selected task adds an empty task, not a copy of it", async () => {
  twoTasks();
  fireEvent.mouseDown(await screen.findByText("200"));
  fireEvent.input(comment(), { target: { value: "правка B" } });
  fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
  await wait(0);
  expect(upserts()).toEqual([
    { ...newTask("t2"), can_id: 0x200, comment: "правка B" }, // правка выделенной досохранена
    newTask("t3"),
  ]);
  expect(txSelected.value).toBe("t3");
});

test("Esc in the table drops the selection and «Добавить» adds the draft", async () => {
  twoTasks();
  fireEvent.mouseDown(await screen.findByText("100"));
  fireEvent.keyDown(screen.getByRole("grid"), { key: "Escape" });
  expect(txSelected.value).toBe(null);
  const id = screen.getByLabelText("ID") as HTMLInputElement;
  expect(id.value).toBe("000"); // редактор — черновик
  fireEvent.input(id, { target: { value: "7DF" } });
  fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
  await wait(0);
  expect(upserts()).toEqual([{ ...newTask("t3"), can_id: 0x7df }]);
});

test("a click on the empty part of the table drops the selection, the scrollbar keeps it", async () => {
  twoTasks();
  fireEvent.mouseDown(await screen.findByText("100"));
  const grid = screen.getByRole("grid");
  Object.defineProperty(grid, "clientWidth", { value: 600, configurable: true });
  Object.defineProperty(grid, "clientHeight", { value: 200, configurable: true });
  fireEvent.mouseDown(grid, { clientX: 620, clientY: 150 }); // полоса прокрутки справа
  expect(txSelected.value).toBe("t1");
  fireEvent.mouseDown(screen.getByText("200")); // строка
  expect(txSelected.value).toBe("t2");
  fireEvent.mouseDown(grid, { clientX: 100, clientY: 150 }); // под строками
  expect(txSelected.value).toBe(null);
});

test("RTR locks the data cells and the task keeps its DLC without data", async () => {
  applyEvent({ type: "tx_state", tasks: [{ ...newTask("t1"), can_id: 0x100, data: "0102" }] });
  render(<TransmitDock />);
  fireEvent.mouseDown(await screen.findByText("100"));
  const cells = () => screen.getAllByLabelText(/^Данные \d$/) as HTMLInputElement[];
  expect(cells().map((c) => c.disabled)).toEqual([false, false, true, true, true, true, true, true]);
  fireEvent.click(screen.getByLabelText("RTR"));
  expect(cells().every((c) => c.disabled && c.value === "")).toBe(true);
  expect((screen.getByRole("button", { name: "Заполнить" }) as HTMLButtonElement).disabled).toBe(true);
  await wait(400);
  expect(upserts()).toEqual([{ ...newTask("t1"), can_id: 0x100, rtr: true, data: "0000" }]);
  act(() => applyEvent({ type: "tx_state", tasks: upserts() })); // эхо сервера
  const row = screen.getByText("100").closest(".gr")!;
  expect(row.querySelectorAll(".byte").length).toBe(0); // в таблице данных у RTR нет
  expect(row.textContent).toContain("CAN RTR");
});

test("trigger data cells follow the trigger DLC", async () => {
  const trigger = { action: "single" as const, delay_ms: 0, channel: 0, can_id: 0x7e8, ext: false, dlc: 2, data: EMPTY8() };
  applyEvent({ type: "tx_state", tasks: [{ ...newTask("t1"), can_id: 0x100, trigger }] });
  render(<TransmitDock />);
  fireEvent.mouseDown(await screen.findByText("100"));
  const trig = document.querySelector(".tx-trig")!;
  const cells = () => [...trig.querySelectorAll<HTMLInputElement>(".bytes input")];
  expect(cells().map((c) => c.disabled)).toEqual([false, false, true, true, true, true, true, true]);
  fireEvent.input(trig.querySelector<HTMLInputElement>("input[maxlength='1']")!, { target: { value: "" } }); // любой DLC
  expect(cells().every((c) => !c.disabled)).toBe(true);
});

test("trigger fields are announced as trigger fields", async () => {
  twoTasks();
  await screen.findByText("100");
  expect(screen.getByLabelText("Триггер: ID")).toBeTruthy();
  expect(screen.getByLabelText("Триггер: DLC")).toBeTruthy();
  expect(screen.getByRole("group", { name: "Триггер: Данные" })).toBeTruthy();
  expect(screen.queryByLabelText(/^Действие /)).toBe(null);
});

test("task IDs are hex in the table even with decimal IDs in the monitor — as in the editor", async () => {
  applyEvent({ type: "settings", settings: { ...store.settings.value, monitor_hex_ids: false } });
  applyEvent({ type: "tx_state", tasks: [{ ...newTask("t1"), can_id: 0x7e0 }] });
  render(<TransmitDock />);
  fireEvent.mouseDown(await screen.findByText("7E0"));
  expect(screen.queryByText("2016")).toBe(null);
  expect((screen.getByLabelText("ID") as HTMLInputElement).value).toBe("7E0");
});

test("«29 bit» does not change the width of the ID field", async () => {
  twoTasks();
  fireEvent.mouseDown(await screen.findByText("100"));
  const id = screen.getByLabelText("ID") as HTMLInputElement;
  const before = id.style.width;
  fireEvent.click(screen.getByLabelText("29 bit"));
  expect(id.value).toBe("100");
  expect(id.style.width).toBe(before);
  expect(before).toBe("96px"); // 8 цифр 29-битного ID
});

test("«Сохранить данные для передачи» confirms the save", async () => {
  replies.tx_save = { name: "transmit.tsk" };
  applyEvent({ type: "tx_state", tasks: [newTask("t1")] });
  transmitActions().find((a) => a.id === "txSave")!.run();
  (dialog.value!.props as unknown as { onPick: (name: string, format: string) => void }).onPick("transmit", "tsk");
  await wait(0);
  expect(calls.find((c) => c.type === "tx_save")?.args).toEqual({ name: "transmit", format: "tsk" });
  expect(store.toasts.value.map((x) => [x.level, x.message])).toEqual([["info", "Список передачи сохранён: transmit.tsk"]]);
});
