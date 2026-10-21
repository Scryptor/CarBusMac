// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
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

import { applyEvent, resetStore, store } from "../src/core/store";
import type { CustomBitrate, DeviceEntry, DevicesState } from "../src/core/types";
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
const HACKER2: DeviceEntry = { ...HACKER, key: "bridge:/dev/cu.usbmodem00000000002B1", path: "/dev/cu.usbmodem00000000002B1", serial: 7001 };
const MONITOR: DeviceEntry = {
  ...HACKER,
  key: "bridge:/dev/cu.usbmodem506NTBKGE1012",
  path: "/dev/cu.usbmodem506NTBKGE1012",
  kind: "other",
  title: "LG Monitor Controls",
  serial: null,
  firmware: null,
  manufacturer: "LG Electronics Inc.",
  product: "LG Monitor Controls",
  vid: 1086,
  pid: 39481,
  selectable: false,
};
const snapshot = (devices: DeviceEntry[], over: Partial<DevicesState> = {}): DevicesState => ({
  devices,
  bridge: { state: "ok", address: "host.docker.internal:7000", message: "" },
  usb: { state: "ok", in_container: true },
  hint: "",
  ...over,
});

beforeEach(() => {
  resetStore();
  calls.length = 0;
  for (const k of Object.keys(replies)) delete replies[k];
  store.connection.value = {
    bridge_host: "host.docker.internal",
    bridge_port: 7000,
    device: "",
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
/** аргументы отправленных команд этого типа (диалог ещё и опрашивает порты — devices_scan) */
const sent = (type: string) => calls.filter((c) => c.type === type).map((c) => c.args);
const deviceSelect = () => screen.getByLabelText("Прибор") as HTMLSelectElement;
const more = () => screen.getByText("Дополнительно").closest("details") as HTMLDetailsElement;
const accept = () => fireEvent.click(screen.getByRole("button", { name: "Принять" }));

test("connect dialog sends channel configs", () => {
  const onClose = vi.fn();
  render(<ConnectDialog onClose={onClose} />);
  fireEvent.input(group("Канал 1: CAN").getByLabelText("Название канала"), { target: { value: "Кузов" } });
  fireEvent.click(group("Канал 1: CAN").getByLabelText("Только слушать"));
  fireEvent.change(group("Канал 2: CAN").getByLabelText("Номинальная скорость"), { target: { value: "c:0" } });
  fireEvent.click(group("Канал 2: CAN").getByLabelText("Автоматическое открытие"));
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  expect(onClose).toHaveBeenCalled();
  expect(sent("connect")).toEqual([
    {
      config: {
        bridge_host: "host.docker.internal",
        bridge_port: 7000,
        device: "",
        channels: [
          { channel: 1, alias: "Кузов", bitrate: 500_000, timing: null, listen_only: true, terminator: false, auto_open: true },
          { channel: 2, alias: "", bitrate: 47_619, timing: custom.timing, listen_only: false, terminator: false, auto_open: true },
        ],
      },
    },
  ]);
});

test("reopened dialog shows the accepted settings, not the startup snapshot", () => {
  render(<ConnectDialog onClose={vi.fn()} />);
  fireEvent.click(group("Канал 1: CAN").getByLabelText("Только слушать"));
  fireEvent.input(group("Канал 2: CAN").getByLabelText("Название канала"), { target: { value: "Шасси" } });
  fireEvent.input(field("Адрес моста"), { target: { value: "10.0.0.5" } });
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  cleanup();
  render(<ConnectDialog onClose={vi.fn()} />);
  expect((group("Канал 1: CAN").getByLabelText("Только слушать") as HTMLInputElement).checked).toBe(true);
  expect((group("Канал 2: CAN").getByLabelText("Название канала") as HTMLInputElement).value).toBe("Шасси");
  expect(field("Адрес моста").value).toBe("10.0.0.5");
  // повторное «Принять» без правок переподключает с теми же настройками («Только слушать» не слетает)
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  const config = sent("connect").at(-1)?.config as { channels: { listen_only: boolean }[] };
  expect(config.channels[0].listen_only).toBe(true);
});

test("connection event from the server updates what the dialog shows", () => {
  applyEvent({
    type: "connection",
    connection: {
      bridge_host: "bridge.local",
      bridge_port: 7002,
      device: "",
      channels: [
        { channel: 1, alias: "", bitrate: 250_000, timing: null, listen_only: true, terminator: false, auto_open: true },
        { channel: 2, alias: "", bitrate: 500_000, timing: null, listen_only: false, terminator: false, auto_open: false },
      ],
    },
  });
  render(<ConnectDialog onClose={vi.fn()} />);
  expect(field("Адрес моста").value).toBe("bridge.local");
  expect((group("Канал 1: CAN").getByLabelText("Номинальная скорость") as HTMLSelectElement).value).toBe("p:250000");
  expect((group("Канал 1: CAN").getByLabelText("Только слушать") as HTMLInputElement).checked).toBe(true);
});

test("bad bridge port keeps the dialog open with an error", () => {
  const onClose = vi.fn();
  render(<ConnectDialog onClose={onClose} />);
  fireEvent.input(field("Порт моста"), { target: { value: "99999" } });
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  expect(screen.getByText("Порт моста: от 1 до 65535")).toBeTruthy();
  expect(more().open).toBe(true); // поле с ошибкой — в «Дополнительно»: раскрыто
  expect(onClose).not.toHaveBeenCalled();
  expect(sent("connect")).toEqual([]);
});

test("the only CAN-Hacker is picked by itself and saved as «automatic»", () => {
  store.devices.value = snapshot([HACKER, MONITOR]);
  render(<ConnectDialog onClose={vi.fn()} />);
  expect(deviceSelect().value).toBe(HACKER.key);
  expect(screen.getByRole("option", { name: "CAN-Hacker v3.2 · № 6950 · 2.2.3.57 — через мост" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Найден прибор");
  expect(document.activeElement).toBe(deviceSelect());
  accept();
  // "" — единственный найденный: конфиг переживёт смену пути порта
  expect(sent("connect").map((a) => (a.config as { device: string }).device)).toEqual([""]);
});

test("with two CAN-Hackers nothing is picked until the user chooses", () => {
  store.devices.value = snapshot([HACKER, HACKER2]);
  const onClose = vi.fn();
  render(<ConnectDialog onClose={onClose} />);
  expect(deviceSelect().value).toBe("");
  expect(screen.getByRole("option", { name: "Выберите прибор…" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Найдено 2 прибора — выберите нужный");
  accept();
  expect(screen.getByRole("alert").textContent).toBe("Выберите прибор");
  expect(onClose).not.toHaveBeenCalled();
  expect(sent("connect")).toEqual([]);
  fireEvent.change(deviceSelect(), { target: { value: HACKER2.key } });
  expect(screen.getByRole("status").textContent).toBe("Найдено 2 прибора");
  expect(screen.queryByRole("alert")).toBeNull();
  accept();
  expect(onClose).toHaveBeenCalled();
  expect(sent("connect").map((a) => (a.config as { device: string }).device)).toEqual([HACKER2.key]);
});

test("the saved device is preselected among several and stays saved by key", () => {
  store.connection.value = { ...store.connection.value!, device: HACKER2.key };
  store.devices.value = snapshot([HACKER, HACKER2]);
  render(<ConnectDialog onClose={vi.fn()} />);
  expect(deviceSelect().value).toBe(HACKER2.key);
  expect(screen.queryByRole("option", { name: "Выберите прибор…" })).toBeNull();
  accept();
  expect(sent("connect").map((a) => (a.config as { device: string }).device)).toEqual([HACKER2.key]);
});

test("ports that are not a CAN-Hacker are listed disabled in their own group", () => {
  store.devices.value = snapshot([HACKER, { ...MONITOR, busy: true }]);
  render(<ConnectDialog onClose={vi.fn()} />);
  const others = within(screen.getByRole("group", { name: "Другие USB-порты — не CAN-Hacker" }));
  const lg = others.getByRole("option", { name: "LG Monitor Controls (cu.usbmodem506NTBKGE1012) — через мост — занят" });
  expect((lg as HTMLOptionElement).disabled).toBe(true);
  expect(deviceSelect().value).toBe(HACKER.key);
});

test("a compatible port is marked as a possible CAN-Hacker, a port held by someone else as busy", () => {
  const compat: DeviceEntry = { ...HACKER2, kind: "compatible", title: "STM32 Virtual ComPort", serial: null, firmware: null };
  applyEvent({ type: "status", state: "opened", message: "", device_info: null, channels: {}, device: HACKER });
  store.devices.value = snapshot([{ ...HACKER, busy: true }, { ...compat, busy: true }], { usb: { state: "ok", in_container: false } });
  render(<ConnectDialog onClose={vi.fn()} />);
  // наш прибор порт держит сам — «занят» не пишем
  expect(screen.getByRole("option", { name: "CAN-Hacker v3.2 · № 6950 · 2.2.3.57 — через мост" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "STM32 Virtual ComPort (возможно, CAN-Hacker) — через мост — занят" })).toBeTruthy();
});

test("no device and the bridge is down: the server's hint is shown and «Дополнительно» opens", () => {
  const hint = "Мост на маке не запущен (host.docker.internal:7000). Запустите ./run-bridge.sh — прибор появится здесь сам.";
  store.devices.value = snapshot([], { bridge: { state: "down", address: "host.docker.internal:7000", message: "Connection refused" }, hint });
  render(<ConnectDialog onClose={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toBe(hint);
  expect(deviceSelect().disabled).toBe(true);
  expect([...deviceSelect().options].map((o) => o.text)).toEqual(["— прибор не найден —"]);
  expect(more().open).toBe(true);
  expect(document.activeElement).toBe(field("Адрес моста"));
});

const NO_BRIDGE = {
  state: "down" as const,
  address: "host.docker.internal:7000",
  message: "Connection refused",
  project_dir: "/Users/igor/dev/canH/carbus-mac",
  command: "cd /Users/igor/dev/canH/carbus-mac && ./run-bridge.sh",
};
const help = () => within(screen.getByRole("note", { name: "Что сделать" }));

test("Docker without the bridge: the dialog says what to do and copies the command for the Terminal", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  store.devices.value = snapshot([], { bridge: NO_BRIDGE, hint: "Мост не запущен (host.docker.internal:7000)." });
  render(<ConnectDialog onClose={vi.fn()} />);
  expect(help().getByText(/Откройте Терминал/)).toBeTruthy();
  expect(help().getByText(NO_BRIDGE.command)).toBeTruthy();
  expect(help().getByText(/Не закрывайте окно Терминала/)).toBeTruthy();
  fireEvent.click(help().getByRole("button", { name: "Копировать" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(NO_BRIDGE.command));
});

test("with the bridge help shown «Дополнительно» stays folded: the address is not the problem", () => {
  store.devices.value = snapshot([], { bridge: NO_BRIDGE, hint: "Мост не запущен (host.docker.internal:7000). Запустите на маке ./run-bridge.sh — прибор появится здесь сам." });
  render(<ConnectDialog onClose={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toBe("Мост не запущен");
  expect(more().open).toBe(false);
});

test("a container started without the project folder: the command fetches the project from GitHub", () => {
  const clone = "[ -d ~/CarBusMac ] || git clone https://github.com/Scryptor/CarBusMac.git ~/CarBusMac; cd ~/CarBusMac && ./run-bridge.sh";
  store.devices.value = snapshot([], { bridge: { ...NO_BRIDGE, project_dir: "", command: clone } });
  render(<ConnectDialog onClose={vi.fn()} />);
  expect(help().getByText(clone)).toBeTruthy();
  expect(help().getByText(/скачает проект с GitHub/)).toBeTruthy();
});

test("the bridge works but CAN-Hacker is not on USB: the dialog asks to plug it in", () => {
  store.devices.value = snapshot([MONITOR]);
  render(<ConnectDialog onClose={vi.fn()} />);
  expect(help().getByText(/Подключите CAN-Hacker к USB/)).toBeTruthy();
  expect(help().queryByRole("button", { name: "Копировать" })).toBeNull();
});

test("the help goes away as soon as the started bridge brings the device", () => {
  store.devices.value = snapshot([], { bridge: NO_BRIDGE });
  render(<ConnectDialog onClose={vi.fn()} />);
  expect(screen.getByRole("note", { name: "Что сделать" })).toBeTruthy();
  act(() => applyEvent({ type: "devices", ...snapshot([HACKER]) }));
  expect(screen.queryByRole("note", { name: "Что сделать" })).toBeNull();
  expect(deviceSelect().value).toBe(HACKER.key);
});

test("«Дополнительно» opens by itself when the bridge stops answering while the dialog is open", () => {
  store.devices.value = snapshot([HACKER]);
  render(<ConnectDialog onClose={vi.fn()} />);
  expect(more().open).toBe(false);
  const foreign = { state: "foreign" as const, address: "host.docker.internal:7000", message: "AirTunes" };
  act(() => applyEvent({ type: "devices", ...snapshot([], { bridge: foreign, hint: "На порту 7000 отвечает не мост CarBUS." }) }));
  expect(more().open).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("На порту 7000 отвечает не мост CarBUS.");
});

test("a devices event updates the list and the status line while the dialog is open", () => {
  store.devices.value = snapshot([MONITOR], { hint: "Мост работает, но CAN-Hacker к маку не подключён." });
  render(<ConnectDialog onClose={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toBe("Мост работает, но CAN-Hacker к маку не подключён.");
  expect(more().open).toBe(false);
  // поле адреса в свёрнутом «Дополнительно» не видно — фокус на первом видимом поле
  expect(document.activeElement).toBe(group("Канал 1: CAN").getByLabelText("Название канала"));
  act(() => applyEvent({ type: "devices", ...snapshot([HACKER, MONITOR]) }));
  expect(deviceSelect().disabled).toBe(false);
  expect(deviceSelect().value).toBe(HACKER.key);
  expect(screen.getByRole("status").textContent).toBe("Найден прибор");
});

test("a device the user picked and then unplugged is reported", () => {
  store.devices.value = snapshot([HACKER, HACKER2]);
  render(<ConnectDialog onClose={vi.fn()} />);
  fireEvent.change(deviceSelect(), { target: { value: HACKER2.key } });
  act(() => applyEvent({ type: "devices", ...snapshot([HACKER]) }));
  expect(screen.getByRole("status").textContent).toBe("Выбранный прибор отключён");
  expect(deviceSelect().value).toBe(HACKER.key);
  // прибор вернулся — выбор пользователя снова в силе
  act(() => applyEvent({ type: "devices", ...snapshot([HACKER, HACKER2]) }));
  expect(deviceSelect().value).toBe(HACKER2.key);
  expect(screen.getByRole("status").textContent).toBe("Найдено 2 прибора");
});

test("devices_scan asks with the bridge address and its answer is shown instead of the stored snapshot", async () => {
  store.devices.value = snapshot([HACKER]);
  replies.devices_scan = snapshot([HACKER, HACKER2]);
  render(<ConnectDialog onClose={vi.fn()} />);
  expect(sent("devices_scan")).toEqual([{ bridge_host: "host.docker.internal", bridge_port: 7000 }]);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Найдено 2 прибора — выберите нужный"));
  expect(screen.getByRole("option", { name: "CAN-Hacker v3.2 · № 7001 · 2.2.3.57 — через мост" })).toBeTruthy();
  // пока окно открыто, показан последний ответ опроса, а не снимок из стора
  act(() => applyEvent({ type: "devices", ...snapshot([]) }));
  expect(screen.getByRole("status").textContent).toBe("Найдено 2 прибора — выберите нужный");
});

test("the dialog polls every 2 s with the current address, skips a bad one and stops when closed", async () => {
  vi.useFakeTimers();
  try {
    render(<ConnectDialog onClose={vi.fn()} />);
    expect(sent("devices_scan")).toEqual([{ bridge_host: "host.docker.internal", bridge_port: 7000 }]);
    fireEvent.input(field("Адрес моста"), { target: { value: "10.0.0.5" } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent("devices_scan").at(-1)).toEqual({ bridge_host: "10.0.0.5", bridge_port: 7000 });
    fireEvent.input(field("Порт моста"), { target: { value: "7k" } });
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent("devices_scan")).toHaveLength(2);
    fireEvent.input(field("Порт моста"), { target: { value: "7001" } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent("devices_scan").at(-1)).toEqual({ bridge_host: "10.0.0.5", bridge_port: 7001 });
    cleanup();
    await vi.advanceTimersByTimeAsync(6000);
    expect(sent("devices_scan")).toHaveLength(3);
  } finally {
    vi.useRealTimers();
  }
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
  expect(sent("bitrates_set")).toHaveLength(1);
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

test("timing far from the typed rate warns first and saves on the second «Принять»", async () => {
  const onClose = vi.fn();
  render(<BitrateManager clockHz={120_000_000} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
  fireEvent.input(field("Скорость"), { target: { value: "1000" } });
  fireEvent.input(field("Делитель"), { target: { value: "8" } });      // 120 МГц / (8 × 24 кванта) = 625 Кбит/с
  expect(screen.getByText(/Тайминг даёт 625 Кбит\/с \(−37,500 %\), а не 1000 Кбит\/с/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  expect(calls).toEqual([]);                                             // сначала — предупреждение
  expect(screen.getByRole("alert").textContent).toContain("Нажмите «Принять» ещё раз");
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(calls.map((c) => c.type)).toEqual(["bitrates_set"]);
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
