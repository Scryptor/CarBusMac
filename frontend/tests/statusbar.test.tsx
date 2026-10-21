// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { connectHooks } from "../src/app/shellActions";
import { client } from "../src/core/client";
import { StatusBar, channelText } from "../src/app/StatusBar";
import { applyEvent, resetStore } from "../src/core/store";
import type { DeviceEntry } from "../src/core/types";

beforeEach(() => {
  resetStore();
  client.state.value = "open"; // связь с сервером есть — статусбар показывает прибор
});
afterEach(() => cleanup());

const opened = {
  type: "status",
  state: "opened",
  message: "",
  device_info: { hardware_name: "HW_CH32", firmware_version: "2.2.3.57", serial_int: 6950 },
  channels: {
    "1": { open: true, alias: "", bitrate: 500000, timing: null, listen_only: true, terminator: false, error: null },
    "2": { open: false, alias: "", bitrate: 125000, timing: null, listen_only: false, terminator: false, error: null },
  },
};

test("status bar shows device and channel states from status event", async () => {
  render(<StatusBar />);
  applyEvent(opened);
  expect(await screen.findByText("Подключено")).toBeTruthy();
  expect(screen.getByText("HW_CH32 2.2.3.57 №6950")).toBeTruthy();
  expect(screen.getByText("К1: 500k, только прослушивание")).toBeTruthy();
  expect(screen.getByText("К2: закрыт")).toBeTruthy();
});

test("status bar shows recording counter", async () => {
  render(<StatusBar />);
  applyEvent({ type: "capture_state", recording: true, count: 2043, duration_s: 10.5, full: false, rev: 0, markers: [] });
  expect(await screen.findByText("Запись")).toBeTruthy();
  expect(screen.getByText("2043")).toBeTruthy();
  expect(screen.getByText("00:00:10")).toBeTruthy();
});

test("channelText formats custom and failed channels", () => {
  expect(channelText(1, { open: true, alias: "", bitrate: 33300, timing: null, listen_only: false, terminator: false, error: null })).toBe("К1: 33,3k");
  expect(channelText(2, { open: false, alias: "", bitrate: 500000, timing: null, listen_only: false, terminator: false, error: "boom" })).toBe("К2: отказ");
  expect(channelText(1, { open: true, alias: "", bitrate: null, timing: { prescaler: 6, seg1: 15, seg2: 4, sjw: 1 }, listen_only: false, terminator: true, error: null })).toBe("К1: своя скорость, 120 Ом");
});

test("status bar shows the background log file while it is written", async () => {
  applyEvent({ type: "status", state: "opened", message: "", device_info: null, channels: {}, log: "2026-10-20_17-30-05.trc" });
  render(<StatusBar />);
  expect(await screen.findByText("Фоновая запись: 2026-10-20_17-30-05.trc")).toBeTruthy();
});

const HACKER: DeviceEntry = {
  key: "bridge:/dev/cu.usbmodem00000000001A1",
  source: "bridge",
  path: "/dev/cu.usbmodem00000000001A1",
  kind: "canhacker",
  title: "CAN-Hacker v3.2",
  serial: 6950,
  firmware: "2.2.3.57",
  manufacturer: "Spectratek",
  product: "CAN-Hacker v3.2 0000000000001B26 2.2.3.57 A06021201",
  usb_serial: "00000000001A",
  vid: 1155,
  pid: 22336,
  busy: false,
  selectable: true,
};
const MONITOR: DeviceEntry = { ...HACKER, key: "bridge:/dev/cu.usbmodem506NTBKGE1012", kind: "other", title: "LG Monitor Controls", selectable: false };
const devices = (list: DeviceEntry[], state = "ok", hint = "") =>
  applyEvent({
    type: "devices",
    devices: list,
    bridge: { state, address: "host.docker.internal:7700", message: "" },
    usb: { state: "ok", in_container: true },
    hint,
  });

test("while not connected the found CAN-Hacker is shown; a click opens the device settings", () => {
  const open = vi.fn();
  connectHooks.openConnectDialog = open;
  try {
    devices([HACKER, MONITOR]);
    render(<StatusBar />);
    const cell = screen.getByRole("button", { name: "Найден: CAN-Hacker v3.2 · № 6950 · 2.2.3.57" });
    expect(cell.title).toBe("CAN-Hacker v3.2 · № 6950 · 2.2.3.57 — через мост");
    fireEvent.click(cell);
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    connectHooks.openConnectDialog = null;
  }
});

test("several found devices are counted, each one in the tooltip", () => {
  devices([HACKER, { ...HACKER, key: "usb:/dev/ttyACM0", source: "usb", serial: 7001 }]);
  render(<StatusBar />);
  const cell = screen.getByRole("button", { name: "Найдено приборов: 2" });
  expect(cell.title).toBe("CAN-Hacker v3.2 · № 6950 · 2.2.3.57 — через мост\nCAN-Hacker v3.2 · № 7001 · 2.2.3.57 — USB в контейнере");
});

test("no device: plain text with the server's explanation; nothing before the first scan", () => {
  render(<StatusBar />);
  expect(screen.queryByText("Прибор не найден")).toBeNull();
  const hint = "Мост на маке не запущен (host.docker.internal:7700). Запустите ./run-bridge.sh — прибор появится здесь сам.";
  act(() => devices([MONITOR], "down", hint));
  const cell = screen.getByText("Прибор не найден");
  expect(cell.title).toBe(hint);
  expect(cell.tagName).toBe("SPAN");
});

test("the device cell is shown after a connection error and hidden while connecting or connected", () => {
  devices([HACKER]);
  applyEvent({ type: "status", state: "error", message: "Мост не отвечает", device_info: null, channels: {}, device: null });
  render(<StatusBar />);
  expect(screen.getByRole("button", { name: /^Найден:/ })).toBeTruthy();
  act(() => applyEvent({ type: "status", state: "opening", message: "", device_info: null, channels: {}, device: null }));
  expect(screen.queryByRole("button", { name: /^Найден:/ })).toBeNull();
  act(() => applyEvent({ ...opened, device: HACKER }));
  expect(screen.queryByRole("button", { name: /^Найден:/ })).toBeNull();
});

test("the connected device is named like in the device settings; after disconnect only the USB search is shown", async () => {
  render(<StatusBar />);
  applyEvent({ ...opened, device: HACKER });
  const cell = await screen.findByText("CAN-Hacker v3.2 · № 6950 · 2.2.3.57");
  expect(cell.getAttribute("title")).toBe("HW_CH32 2.2.3.57 №6950 — через мост: /dev/cu.usbmodem00000000001A1");
  // отключились: сведения прибора остаются в сторе (для «Информации об устройстве»), но в статусе
  // не висят рядом с «Не подключен» — там только результат поиска по USB
  act(() => applyEvent({ ...opened, state: "closed", device: null }));
  expect(screen.queryByText("HW_CH32 2.2.3.57 №6950")).toBeNull();
  expect(screen.queryByText("CAN-Hacker v3.2 · № 6950 · 2.2.3.57")).toBeNull();
});

test("without the server only the link state is shown: no stale «Подключено» or frozen RX rate", async () => {
  render(<StatusBar />);
  applyEvent({ ...opened, device: HACKER });
  await screen.findByText("Подключено");
  act(() => {
    client.state.value = "closed";
  });
  expect(screen.queryByText("Подключено")).toBeNull();
  expect(screen.queryByText(/^RX /)).toBeNull();
  expect(screen.getByText("Нет связи с сервером")).toBeTruthy();
  act(() => {
    client.state.value = "open";
  });
  expect(screen.getByText("Подключено")).toBeTruthy();
});
