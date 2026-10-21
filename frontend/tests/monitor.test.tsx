// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const calls: { type: string; args: Record<string, unknown> }[] = [];
vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: (type: string, args: Record<string, unknown> = {}) => {
    calls.push({ type, args });
    return Promise.resolve({});
  },
}));

import { closeDialog, dialog, floats, ui } from "../src/app/ui";
import { clearActions, runAction } from "../src/core/actions";
import { resetStore } from "../src/core/store";
import { MonitorPanel, ingestMonitorRows, monitorSelection, monitorStore } from "../src/features/monitor/MonitorGrid";
import { registerMonitorActions } from "../src/features/monitor/actions";
import { streamSelection } from "../src/features/stream/StreamGrid";

function DialogHost() {
  return <>{dialog.value}</>;
}

beforeEach(() => {
  resetStore();
  clearActions();
  monitorStore.reset();
  calls.length = 0;
});
afterEach(() => {
  cleanup();
  ui.receiveMode.value = "monitor";
  streamSelection.value = null;
  floats.value = new Map();
  closeDialog();
});

test("in the stream mode F3, Ctrl+F3 and F4 act on the stream row, not on the hidden monitor selection", () => {
  registerMonitorActions();
  ingestMonitorRows([mrow("0102", 0)]);
  monitorSelection.value = monitorStore.get("1:291:0") ?? null; // в мониторе выделен 123
  ui.receiveMode.value = "stream";
  streamSelection.value = { i: 5, t: 0, ch: 2, dir: "rx", id: 0x3fb, ext: false, rtr: false, dlc: 1, data: "0c", marker: null };
  expect(runAction("bitmap")).toBe(true);
  expect(runAction("frames")).toBe(true);
  // битовая карта потока — одно окно, идущее за выделением; «Данные сообщения» — по буферу потока
  expect([...floats.value.keys()].sort()).toEqual(["bitmap:stream", "frames:stream:2:1019:0"]);
  render(<>{floats.value.get("bitmap:stream")}</>);
  expect(screen.getByText("[2] 3FB — строка 6 потока")).toBeTruthy();
  expect(screen.getByRole("table", { name: "Битовая карта" }).querySelector("[data-byte='0'] .bm-dec")?.textContent).toBe("12");
  act(() => {
    streamSelection.value = { i: 9, t: 1, ch: 2, dir: "rx", id: 0x3fb, ext: false, rtr: false, dlc: 1, data: "0d", marker: null };
  });
  expect(screen.getByText("[2] 3FB — строка 10 потока")).toBeTruthy();
  const bits = screen.getByRole("table", { name: "Битовая карта" }).querySelectorAll("[data-byte='0'] .bit");
  expect([...bits].map((b) => b.classList.contains("chg"))).toEqual([false, false, false, false, false, false, false, true]); // 0C → 0D
  cleanup();
  expect(runAction("comment")).toBe(true);
  render(dialog.value!);
  expect(screen.getByRole("dialog", { name: "Изменить комментарий для 3FB" })).toBeTruthy();
  // без выделенной строки потока действия недоступны, даже если в мониторе что-то выделено
  streamSelection.value = null;
  expect(runAction("bitmap")).toBe(false);
});

const mrow = (data: string, changed: number) => ({
  ch: 1, id: 0x123, ext: false, rtr: false, fd: false, brs: false, dlc: data.length / 2, data, count: 1, period_ms: 20,
  changed, stable_ms: [null, null], fc: 0, ts: 1,
});

test("byte highlight phase is set once: re-renders do not speed up the fade", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(1000);
  try {
    render(<MonitorPanel />);
    ingestMonitorRows([mrow("0102", 0b01)]);
    const lit = await screen.findByText("01");
    expect(lit.className).toContain("chg");
    const phase = lit.style.animationDelay;
    expect(phase).toBe("-0ms");
    // тик через 500 мс без изменения байта: элемент тот же, фаза анимации прежняя —
    // иначе к её собственному ходу прибавилось бы ещё 500 мс и подсветка гасла бы вдвое быстрее
    now.mockReturnValue(1500);
    ingestMonitorRows([mrow("0102", 0)]);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("01")).toBe(lit);
    expect(lit.style.animationDelay).toBe(phase);
    // таблицу нарисовали заново (вкладку переключили) — новый элемент продолжает с той же точки
    cleanup();
    render(<MonitorPanel />);
    const again = await screen.findByText("01");
    expect(again).not.toBe(lit);
    expect(again.style.animationDelay).toBe("-500ms");
  } finally {
    now.mockRestore();
  }
});

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
  fireEvent.click(screen.getByText("Установить")); // кнопка окна комментария десктопа (TdlgComment)
  expect(calls).toContainEqual({ type: "comment_set", args: { id: 0x123, ext: false, text: "кнопка руля" } });
});
