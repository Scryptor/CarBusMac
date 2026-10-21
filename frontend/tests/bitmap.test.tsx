// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] as { type: string; args: Record<string, unknown> }[] }));
vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: (type: string, args: Record<string, unknown> = {}) => {
    calls.push({ type, args });
    return Promise.resolve({ rows: [] });
  },
}));

import { floats } from "../src/app/ui";
import { applyEvent, resetStore } from "../src/core/store";
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
  calls.length = 0;
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

test("bit highlight phase is set once per lit element", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(1000);
  try {
    render(<Floats />);
    ingestMonitorRows([row(1, 0x120, "0000")]);
    act(() => openBitmap(1, 0x120, false)); // окно и его подписка на монитор готовы
    const win = await screen.findByRole("dialog", { name: "[1] 120: Детали сообщения" });
    now.mockReturnValue(1200);
    act(() => ingestMonitorRows([row(1, 0x120, "8000")])); // переключился x80 байта 0
    const bit = win.querySelector('[data-byte="0"] .bit.chg') as HTMLElement;
    expect(bit.textContent).toBe("1");
    expect(bit.style.animationDelay).toBe("-0ms");
    now.mockReturnValue(1700);
    act(() => ingestMonitorRows([row(1, 0x120, "8001")])); // сменился байт 1 — окно перерисовалось
    expect(win.querySelector('[data-byte="1"] .bit.chg')).toBeTruthy();
    expect(win.querySelector('[data-byte="0"] .bit.chg')).toBe(bit);
    expect(bit.style.animationDelay).toBe("-0ms");
  } finally {
    now.mockRestore();
  }
});

test("comment field follows the stored comment and sends only a real edit", async () => {
  render(<Floats />);
  ingestMonitorRows([row(1, 0x120, "00")]);
  act(() => openBitmap(1, 0x120, false));
  const input = (await screen.findByLabelText("Комментарий")) as HTMLInputElement;
  // комментарий сменили в другом месте (F4, другая вкладка) — поле показывает новый
  act(() => applyEvent({ type: "comments", comments: { "288:0": "новый" } }));
  expect(input.value).toBe("новый");
  // зашли в поле и ушли без правки — ничего не шлём (раньше уходил устаревший текст и затирал новый)
  fireEvent.focus(input);
  fireEvent.blur(input);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(calls.filter((c) => c.type === "comment_set")).toEqual([]);
  // настоящая правка уходит один раз
  fireEvent.input(input, { target: { value: "дверь" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.blur(input);
  expect(calls.filter((c) => c.type === "comment_set")).toEqual([
    { type: "comment_set", args: { id: 0x120, ext: false, text: "дверь" } },
  ]);
});

test("after the monitor is cleared the window says the message is gone", async () => {
  render(<Floats />);
  ingestMonitorRows([row(1, 0x120, "0e0062aa")]);
  act(() => openBitmap(1, 0x120, false));
  const win = await screen.findByRole("dialog", { name: "[1] 120: Детали сообщения" });
  expect(win.querySelectorAll(".bit").length).toBe(32);
  act(() => monitorStore.reset());
  expect(win.textContent).toContain("Сообщение пропало из монитора");
  expect(win.querySelectorAll(".bit").length).toBe(0);
  // сообщение пришло снова — это первые данные, подсвечивать нечего (сравнивать не с чем)
  act(() => ingestMonitorRows([row(1, 0x120, "ff0062aa")]));
  expect(win.querySelectorAll(".bit").length).toBe(32);
  expect(win.querySelectorAll(".bit.chg").length).toBe(0);
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
