// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const calls: { type: string; args: Record<string, unknown> }[] = [];
vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: (type: string, args: Record<string, unknown> = {}) => {
    calls.push({ type, args });
    return Promise.resolve({});
  },
}));

import { applyEvent, resetStore, store } from "../src/core/store";
import type { CustomBitrate } from "../src/core/types";
import { BitrateManager } from "../src/features/device/BitrateManager";
import { ConnectDialog } from "../src/features/device/ConnectDialog";
import { DeviceInfoDialog } from "../src/features/device/DeviceInfoDialog";
import { registerDevice } from "../src/features/device/register";
import { connectHooks } from "../src/app/shellActions";
import { closeDialog, dialog } from "../src/app/ui";
import { runAction } from "../src/core/actions";

const custom: CustomBitrate = {
  caption: "Кузов VAG",
  bitrate: 47_619,
  sample_pct: 80,
  clock_hz: 120_000_000,
  timing: { prescaler: 126, seg1: 15, seg2: 4, sjw: 4 },
};

beforeEach(() => {
  resetStore();
  calls.length = 0;
  store.connection.value = {
    bridge_host: "host.docker.internal",
    bridge_port: 7000,
    channels: [
      { channel: 1, alias: "", bitrate: 500_000, timing: null, listen_only: false, terminator: false, auto_open: true },
      { channel: 2, alias: "", bitrate: 500_000, timing: null, listen_only: false, terminator: false, auto_open: false },
    ],
  };
  store.bitrates.value = [custom];
});
afterEach(() => cleanup());

const group = (name: string) => within(screen.getByRole("group", { name }));
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

test("connect dialog sends channel configs", () => {
  const onClose = vi.fn();
  render(<ConnectDialog onClose={onClose} />);
  fireEvent.input(group("Канал 1: CAN").getByLabelText("Название канала"), { target: { value: "Кузов" } });
  fireEvent.click(group("Канал 1: CAN").getByLabelText("Только слушать"));
  fireEvent.change(group("Канал 2: CAN").getByLabelText("Номинальная скорость"), { target: { value: "c:0" } });
  fireEvent.click(group("Канал 2: CAN").getByLabelText("Открывать после подключения"));
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  expect(onClose).toHaveBeenCalled();
  expect(calls).toEqual([
    {
      type: "connect",
      args: {
        config: {
          bridge_host: "host.docker.internal",
          bridge_port: 7000,
          channels: [
            { channel: 1, alias: "Кузов", bitrate: 500_000, timing: null, listen_only: true, terminator: false, auto_open: true },
            { channel: 2, alias: "", bitrate: 47_619, timing: custom.timing, listen_only: false, terminator: false, auto_open: true },
          ],
        },
      },
    },
  ]);
});

test("bad bridge port keeps the dialog open with an error", () => {
  const onClose = vi.fn();
  render(<ConnectDialog onClose={onClose} />);
  fireEvent.input(field("Порт моста"), { target: { value: "99999" } });
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  expect(screen.getByText("Порт моста: от 1 до 65535")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
});

test("terminator is disabled where the connected device lacks it", () => {
  applyEvent({
    type: "status",
    state: "opened",
    message: "",
    device_info: { channel_features: { "1": { terminator: true }, "2": { terminator: false } } },
    channels: {},
  });
  render(<ConnectDialog />);
  const t1 = group("Канал 1: CAN").getByLabelText("Включить терминатор 120 Ом") as HTMLInputElement;
  const t2 = group("Канал 2: CAN").getByLabelText("Включить терминатор 120 Ом") as HTMLInputElement;
  expect(t1.disabled).toBe(false);
  expect(t2.disabled).toBe(true);
});

test("a bitrate added in the manager becomes the channel's choice", async () => {
  store.bitrates.value = [];
  render(<ConnectDialog />);
  fireEvent.click(group("Канал 2: CAN").getByRole("button", { name: "Настроить скорости" }));
  fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
  fireEvent.input(field("Скорость"), { target: { value: "47,619" } });
  fireEvent.input(field("Точка выборки"), { target: { value: "80" } });
  const manager = within(screen.getByRole("dialog", { name: "Управление скоростями" }));
  fireEvent.click(manager.getByRole("button", { name: "Принять" }));
  await waitFor(() =>
    expect((group("Канал 2: CAN").getByLabelText("Номинальная скорость") as HTMLSelectElement).value).toBe("c:0"),
  );
  expect(calls[0].type).toBe("bitrates_set");
});

test("bitrate manager computes timing from rate and sample point", () => {
  render(<BitrateManager clockHz={120_000_000} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
  fireEvent.input(field("Скорость"), { target: { value: "47,619" } });
  fireEvent.input(field("Точка выборки"), { target: { value: "80" } });
  expect([field("Делитель").value, field("Seg1").value, field("Seg2").value, field("Sync.Jump Width").value]).toEqual([
    "126",
    "15",
    "4",
    "4",
  ]);
  expect(field("Фактическая скорость").value).toBe("47,619");
  expect(field("Фактическая точка выборки").value).toBe("80");
  expect(field("Точность").value).toBe("0,000");
});

test("editing the prescaler recomputes the actual rate and accuracy", () => {
  render(<BitrateManager clockHz={120_000_000} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("option", { name: "Кузов VAG — 47,619 Кбит/с" }));
  fireEvent.input(field("Делитель"), { target: { value: "125" } });
  expect(field("Фактическая скорость").value).toBe("48");
  expect(field("Точность").value).toBe("+0,800");
});

test("bitrate manager saves the list with the clock", async () => {
  const onClose = vi.fn();
  render(<BitrateManager clockHz={120_000_000} onClose={onClose} />);
  fireEvent.click(screen.getByRole("option", { name: "Кузов VAG — 47,619 Кбит/с" }));
  fireEvent.input(field("Название"), { target: { value: "Кузов" } });
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(calls).toEqual([{ type: "bitrates_set", args: { bitrates: [{ ...custom, caption: "Кузов" }] } }]);
});

test("invalid timing blocks saving and names the field", () => {
  render(<BitrateManager clockHz={120_000_000} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("option", { name: "Кузов VAG — 47,619 Кбит/с" }));
  fireEvent.input(field("Seg1"), { target: { value: "300" } });
  expect(screen.getByText("Seg1: от 1 до 256")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  expect(calls).toEqual([]);
});

test("device info dialog shows the memo and copies it", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  applyEvent({
    type: "status",
    state: "opened",
    message: "",
    device_info: { hardware_name: "HW_CH32", firmware_version: "2.2.3.57", serial_int: 6950, channel_types: { "1": "CAN" } },
    channels: {},
  });
  render(<DeviceInfoDialog />);
  const memo = screen.getByLabelText("Сведения об устройстве").textContent ?? "";
  expect(memo).toContain("Устройство: HW_CH32");
  expect(memo).toContain("Прошивка: 2.2.3.57");
  fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(memo));
});

test("registerDevice opens the settings dialog from connect and the settings menu", () => {
  registerDevice();
  expect(runAction("deviceSettings")).toBe(true);
  expect(dialog.value).not.toBeNull();
  closeDialog();
  connectHooks.openConnectDialog!();
  expect(dialog.value).not.toBeNull();
  closeDialog();
  expect(runAction("deviceInfo")).toBe(false); // прибор ещё не подключался — пункт недоступен
});
