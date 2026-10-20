import { expect, test } from "vitest";
import type { ChannelConfig, CustomBitrate, DeviceInfo } from "../src/core/types";
import {
  applyChoice,
  bitrateOptions,
  choiceOf,
  deviceInfoLines,
  kbpsLabel,
  parseBridge,
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
