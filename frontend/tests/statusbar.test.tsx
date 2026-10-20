// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test } from "vitest";
import { StatusBar, channelText } from "../src/app/StatusBar";
import { applyEvent, resetStore } from "../src/core/store";

beforeEach(() => resetStore());
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
