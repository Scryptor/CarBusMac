import { expect, test } from "vitest";
import type { ChannelConfig, CustomBitrate, DeviceEntry, DeviceInfo, DevicesState } from "../src/core/types";
import {
  applyChoice,
  asDevicesState,
  bitrateOptions,
  bridgeUnreachable,
  choiceOf,
  deviceInfoLines,
  deviceLabel,
  deviceOption,
  deviceStatus,
  deviceToSave,
  deviceVia,
  kbpsLabel,
  parseBridge,
  pickDevice,
  selectableDevices,
  setupHelp,
} from "../src/features/device/deviceModel";

const custom: CustomBitrate = {
  caption: "Кузов VAG",
  bitrate: 47_619,
  sample_pct: 80,
  clock_hz: 120_000_000,
  timing: { prescaler: 126, seg1: 15, seg2: 4, sjw: 4 },
};
const ch = (over: Partial<ChannelConfig> = {}): ChannelConfig => ({
  channel: 1,
  alias: "",
  bitrate: 500_000,
  timing: null,
  listen_only: false,
  terminator: false,
  auto_open: true,
  ...over,
});

test("kbpsLabel trims trailing zeros with a decimal comma", () => {
  expect(kbpsLabel(500_000)).toBe("500 Кбит/с");
  expect(kbpsLabel(33_300)).toBe("33,3 Кбит/с");
  expect(kbpsLabel(47_619)).toBe("47,619 Кбит/с");
});

test("choiceOf finds the preset, the custom entry or the orphan timing", () => {
  expect(choiceOf(ch(), [custom])).toBe("p:500000");
  expect(choiceOf(ch({ bitrate: 47_619, timing: { ...custom.timing } }), [custom])).toBe("c:0");
  expect(choiceOf(ch({ bitrate: 47_619, timing: { prescaler: 1, seg1: 13, seg2: 2, sjw: 1 } }), [custom])).toBe("cur");
});

test("bitrateOptions lists presets, customs and the orphan only when needed", () => {
  const opts = bitrateOptions([custom], ch());
  expect(opts).toHaveLength(15);
  expect(opts[0]).toEqual({ value: "p:10000", label: "10 Кбит/с" });
  expect(opts[14]).toEqual({ value: "c:0", label: "Кузов VAG — 47,619 Кбит/с" });
  const orphan = bitrateOptions([], ch({ bitrate: 47_619, timing: { ...custom.timing } }));
  expect(orphan.at(-1)).toEqual({ value: "cur", label: "Своя — 47,619 Кбит/с" });
});

test("applyChoice turns a choice into bitrate and timing", () => {
  expect(applyChoice("p:125000", ch(), [custom])).toEqual({ bitrate: 125_000, timing: null });
  expect(applyChoice("c:0", ch(), [custom])).toEqual({ bitrate: 47_619, timing: custom.timing });
  const own = ch({ bitrate: 47_619, timing: { prescaler: 1, seg1: 13, seg2: 2, sjw: 1 } });
  expect(applyChoice("cur", own, [])).toEqual({ bitrate: 47_619, timing: own.timing });
});

test("parseBridge validates host and port", () => {
  expect(parseBridge("  localhost ", "7000")).toEqual({ bridge_host: "localhost", bridge_port: 7000 });
  expect(() => parseBridge("", "7000")).toThrow("Укажите адрес моста");
  expect(() => parseBridge("h", "70000")).toThrow("Порт моста: от 1 до 65535");
  expect(() => parseBridge("h", "7k")).toThrow("Порт моста: от 1 до 65535");
});

const INFO: DeviceInfo = {
  hardware_name: "HW_CH32",
  firmware_version: "2.2.3.57",
  serial_int: 6950,
  feature_gateway: true,
  feature_isotp: false,
  feature_tx_buffer: false,
  feature_tx_task: false,
  channel_types: { "1": "CAN", "2": "CAN", "3": "LIN" },
  channel_features: { "1": { terminator: true, alc: false }, "2": { terminator: false } },
  channel_frequencies: { "1": 120_000_000, "2": 120_000_000 },
  filters_info: [
    { channel: 1, size: 14 },
    { channel: 2, size: 1 },
  ],
};

test("deviceInfoLines reads like the desktop memo", () => {
  expect(deviceInfoLines(INFO)).toEqual([
    "Устройство: HW_CH32",
    "Серийный номер: 6950",
    "Прошивка: 2.2.3.57",
    "",
    "Возможности:",
    "  Шлюз",
    "",
    "Каналы:",
    "  Канал 1: CAN, 120 МГц, 14 фильтров",
    "    Возможности:",
    "      Терминатор 120 Ом",
    "  Канал 2: CAN, 120 МГц, 1 фильтр",
    "    Возможности:",
    "      Нет дополнительных функций",
    "  Канал 3: LIN",
  ]);
});

test("deviceInfoLines says when there are no extra features", () => {
  const lines = deviceInfoLines({ ...INFO, feature_gateway: false });
  expect(lines.slice(4, 6)).toEqual(["Возможности:", "  Нет дополнительных функций"]);
});

test("deviceInfoLines shows the live channel state when connected", () => {
  const lines = deviceInfoLines(INFO, {
    "1": { open: true, alias: "", bitrate: 500_000, timing: null, listen_only: true, terminator: true, error: null },
    "2": { open: false, alias: "", bitrate: 125_000, timing: null, listen_only: false, terminator: false, error: null },
  });
  expect(deviceInfoLines(INFO, { "1": { open: true, alias: "", bitrate: 500_000, timing: null, listen_only: false, terminator: false, error: null } })).toContain(
    "    Состояние: открыт, 500 Кбит/с",
  );
  const ch1 = lines.indexOf("  Канал 1: CAN, 120 МГц, 14 фильтров");
  expect(lines[ch1 + 1]).toBe("    Состояние: открыт, 500 Кбит/с, только прослушивание, терминатор включён");
  expect(lines).toContain("    Состояние: закрыт");
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
const HACKER2: DeviceEntry = { ...HACKER, key: "bridge:/dev/cu.usbmodem00000000002B1", path: "/dev/cu.usbmodem00000000002B1", serial: 7001 };
const COMPAT: DeviceEntry = { ...HACKER, key: "usb:/dev/ttyACM0", source: "usb", path: "/dev/ttyACM0", kind: "compatible", title: "STM32 Virtual ComPort", serial: null, firmware: null };
const MONITOR: DeviceEntry = {
  ...HACKER,
  key: "bridge:/dev/cu.usbmodem506NTBKGE1012",
  path: "/dev/cu.usbmodem506NTBKGE1012",
  kind: "other",
  title: "LG Monitor Controls",
  serial: null,
  firmware: null,
  selectable: false,
};
const snap = (devices: DeviceEntry[], over: Partial<DevicesState> = {}): DevicesState => ({
  devices,
  bridge: { state: "ok", address: "host.docker.internal:7000", message: "" },
  usb: { state: "ok", in_container: true },
  hint: "",
  ...over,
});
const down = { state: "down" as const, address: "host.docker.internal:7000", message: "Connection refused" };

test("deviceLabel: model, serial and firmware; a foreign port by its node name", () => {
  expect(deviceLabel(HACKER)).toBe("CAN-Hacker v3.2 · № 6950 · 2.2.3.57");
  expect(deviceLabel({ ...HACKER, serial: null })).toBe("CAN-Hacker v3.2 · 2.2.3.57");
  expect(deviceLabel(COMPAT)).toBe("STM32 Virtual ComPort");
  expect(deviceLabel({ ...COMPAT, title: "" })).toBe("ttyACM0");
  expect(deviceLabel(MONITOR)).toBe("LG Monitor Controls (cu.usbmodem506NTBKGE1012)");
});

test("deviceVia names the way the backend sees the port", () => {
  expect(deviceVia(HACKER, true)).toBe("через мост");
  expect(deviceVia(COMPAT, true)).toBe("USB в контейнере");
  expect(deviceVia(COMPAT, false)).toBe("USB");
  expect(deviceVia({ ...HACKER, key: "demo:CAN-Hacker", source: "demo" }, false)).toBe("демо");
});

test("deviceOption marks a compatible port and a port busy with someone else's connection", () => {
  expect(deviceOption(HACKER, true, "")).toBe("CAN-Hacker v3.2 · № 6950 · 2.2.3.57 — через мост");
  expect(deviceOption(COMPAT, false, "")).toBe("STM32 Virtual ComPort (возможно, CAN-Hacker) — USB");
  expect(deviceOption({ ...HACKER, busy: true }, true, "")).toBe("CAN-Hacker v3.2 · № 6950 · 2.2.3.57 — через мост — занят");
  expect(deviceOption({ ...HACKER, busy: true }, true, HACKER.key)).toBe("CAN-Hacker v3.2 · № 6950 · 2.2.3.57 — через мост");
});

test("selectableDevices keeps the server order and drops foreign ports", () => {
  expect(selectableDevices(snap([HACKER2, COMPAT, MONITOR, HACKER]))).toEqual([HACKER2, COMPAT, HACKER]);
});

test("pickDevice: the user's choice, then the saved one, then the only one found", () => {
  const two = [HACKER, HACKER2];
  expect(pickDevice(HACKER2.key, HACKER.key, two)).toBe(HACKER2.key);
  expect(pickDevice("", HACKER2.key, two)).toBe(HACKER2.key);
  expect(pickDevice("", "", two)).toBe("");
  expect(pickDevice("", "", [HACKER])).toBe(HACKER.key);
  // выбранного и сохранённого уже нет — единственный найденный
  expect(pickDevice(HACKER2.key, HACKER2.key, [HACKER])).toBe(HACKER.key);
  expect(pickDevice(HACKER2.key, "", [HACKER, COMPAT])).toBe("");
  expect(pickDevice("", "usb:/dev/ttyACM0", [])).toBe("");
});

test("deviceToSave: the only device is saved as automatic, nothing found keeps the old value", () => {
  expect(deviceToSave(HACKER.key, "", [HACKER])).toBe("");
  expect(deviceToSave(HACKER.key, HACKER.key, [HACKER])).toBe("");
  expect(deviceToSave(HACKER2.key, "", [HACKER, HACKER2])).toBe(HACKER2.key);
  expect(deviceToSave("", HACKER2.key, [])).toBe(HACKER2.key);
  expect(deviceToSave("", "", [])).toBe("");
});

test("deviceStatus: searching, not found, found, connected", () => {
  expect(deviceStatus(snap([], { bridge: { state: "unknown", address: "", message: "" } }), "", "", "")).toEqual({
    tone: "idle",
    text: "Поиск прибора…",
  });
  const hint = "Мост на маке не запущен (host.docker.internal:7000). Запустите ./run-bridge.sh — прибор появится здесь сам.";
  expect(deviceStatus(snap([], { bridge: down, hint }), "", "", "")).toEqual({ tone: "err", text: hint });
  expect(deviceStatus(snap([MONITOR]), "", "", "")).toEqual({ tone: "err", text: "CAN-Hacker не найден" });
  expect(deviceStatus(snap([HACKER, MONITOR]), "", HACKER.key, "")).toEqual({ tone: "ok", text: "Найден прибор" });
  expect(deviceStatus(snap([HACKER]), "", HACKER.key, HACKER.key)).toEqual({ tone: "ok", text: "Подключён" });
});

test("deviceStatus: several devices ask for a choice, with the right word forms", () => {
  expect(deviceStatus(snap([HACKER, HACKER2]), "", "", "")).toEqual({ tone: "warn", text: "Найдено 2 прибора — выберите нужный" });
  expect(deviceStatus(snap([HACKER, HACKER2]), "", HACKER.key, "")).toEqual({ tone: "ok", text: "Найдено 2 прибора" });
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...HACKER, key: `usb:/dev/ttyACM${i}` }));
  expect(deviceStatus(snap(many(5)), "", "", "").text).toBe("Найдено 5 приборов — выберите нужный");
  expect(deviceStatus(snap(many(21)), "", "", "").text).toBe("Найден 21 прибор — выберите нужный");
});

test("deviceStatus: the device the user picked has gone", () => {
  expect(deviceStatus(snap([HACKER]), HACKER2.key, HACKER.key, "")).toEqual({ tone: "warn", text: "Выбранный прибор отключён" });
  expect(deviceStatus(snap([], { bridge: down }), HACKER2.key, "", "")).toEqual({ tone: "warn", text: "Выбранный прибор отключён" });
});

test("bridgeUnreachable: the bridge is down or foreign and no device is found", () => {
  expect(bridgeUnreachable(snap([], { bridge: down }))).toBe(true);
  expect(bridgeUnreachable(snap([MONITOR], { bridge: { ...down, state: "foreign" } }))).toBe(true);
  expect(bridgeUnreachable(snap([COMPAT], { bridge: down }))).toBe(false); // USB в контейнере работает и без моста
  expect(bridgeUnreachable(snap([]))).toBe(false);
});

const RUN = "cd /Users/igor/dev/canH/carbus-mac && ./run-bridge.sh";
const CLONE = "[ -d ~/CarBusMac ] || git clone https://github.com/Scryptor/CarBusMac.git ~/CarBusMac; cd ~/CarBusMac && ./run-bridge.sh";
const noBridge = { ...down, project_dir: "/Users/igor/dev/canH/carbus-mac", command: RUN };

test("setupHelp: Docker without the bridge — start it with the server's command; the bridge without a device — plug it in", () => {
  expect(setupHelp(snap([], { bridge: noBridge }))).toEqual({ kind: "bridge", command: RUN, fromGitHub: false });
  expect(setupHelp(snap([MONITOR], { bridge: { ...noBridge, state: "foreign" } }))).toEqual({ kind: "bridge", command: RUN, fromGitHub: false });
  // контейнер запущен из образа без папки проекта — команда сама скачает проект
  expect(setupHelp(snap([], { bridge: { ...down, project_dir: "", command: CLONE } }))).toEqual({ kind: "bridge", command: CLONE, fromGitHub: true });
  expect(setupHelp(snap([]))).toEqual({ kind: "plug" });
  expect(setupHelp(snap([MONITOR]))).toEqual({ kind: "plug" });
});

test("deviceStatus: with the bridge help below, the line only names the reason instead of repeating the server's hint", () => {
  const hint = "Мост не запущен (host.docker.internal:7000). Запустите на маке ./run-bridge.sh — прибор появится здесь сам.";
  expect(deviceStatus(snap([], { bridge: noBridge, hint }), "", "", "")).toEqual({ tone: "err", text: "Мост не запущен" });
  expect(deviceStatus(snap([], { bridge: { ...noBridge, state: "foreign" }, hint }), "", "", "")).toEqual({
    tone: "err",
    text: "Мост не отвечает: на его порту другая программа (обычно «Приёмник AirPlay»)",
  });
});

test("setupHelp is silent with a device, while searching, outside Docker and without a command", () => {
  expect(setupHelp(snap([HACKER]))).toBeNull();
  expect(setupHelp(snap([COMPAT], { bridge: noBridge }))).toBeNull(); // USB в контейнере работает и без моста
  expect(setupHelp(snap([], { bridge: { state: "unknown", address: "", message: "" } }))).toBeNull();
  expect(setupHelp(snap([], { bridge: noBridge, usb: { state: "ok", in_container: false } }))).toBeNull(); // бэкенд без Docker видит USB сам
  expect(setupHelp(snap([], { bridge: down }))).toBeNull(); // сервер не прислал команду — показывать нечего
});

test("asDevicesState accepts only a snapshot with a device list", () => {
  expect(asDevicesState({})).toBeNull();
  expect(asDevicesState(null)).toBeNull();
  expect(asDevicesState("devices")).toBeNull();
  expect(asDevicesState(snap([HACKER]))).toEqual(snap([HACKER]));
  // чего нет в ответе — из пустого снимка
  expect(asDevicesState({ devices: [] })).toEqual({
    devices: [],
    bridge: { state: "unknown", address: "", message: "" },
    usb: { state: "ok", in_container: false },
    hint: "",
  });
});

test("pickDevice: the device of the open connection beats a second one plugged in later", () => {
  const two = [HACKER, HACKER2];
  expect(pickDevice("", "", two, HACKER2.key)).toBe(HACKER2.key);
  expect(pickDevice("", HACKER.key, two, HACKER2.key)).toBe(HACKER.key);    // сохранённый выбор главнее
  expect(pickDevice("", "", two, "bridge:/dev/gone")).toBe("");
});
