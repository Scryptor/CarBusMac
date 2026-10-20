import { beforeEach, expect, test, vi } from "vitest";

const calls: { type: string; args: Record<string, unknown> }[] = [];
vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: (type: string, args: Record<string, unknown> = {}) => {
    calls.push({ type, args });
    return Promise.resolve({});
  },
}));

import { applyEvent, resetStore } from "../src/core/store";
import { channelMenu } from "../src/features/device/ChannelMenu";
import type { MenuItem } from "../src/ui/Menu";

type Sub = Extract<MenuItem, { items: MenuItem[] }>;
type Run = Extract<MenuItem, { run: () => void }>;

const chan = (over: object) => ({ open: true, alias: "", bitrate: 500_000, timing: null, listen_only: false, terminator: false, error: null, ...over });

beforeEach(() => {
  resetStore();
  calls.length = 0;
  applyEvent({
    type: "status",
    state: "opened",
    message: "",
    device_info: { channel_features: { "1": { terminator: true } } },
    channels: { "1": chan({ alias: "Кузов" }), "2": chan({}) },
  });
});

test("channel menu has device info, a submenu per channel and device settings", () => {
  const items = channelMenu();
  expect(items[0]).toEqual({ action: "deviceInfo" });
  const subs = items.filter((i): i is Sub => "items" in i);
  expect(subs.map((s) => s.label)).toEqual(["Канал 1: Кузов", "Канал 2"]);
  expect((items.at(-1) as Run).label).toBe("Настройки устройства…");
});

test("terminator toggles only where the device has one", () => {
  const subs = channelMenu().filter((i): i is Sub => "items" in i);
  const [t1] = subs[0].items as Run[];
  const [t2] = subs[1].items as Run[];
  expect([t1.label, t1.checked, t1.disabled]).toEqual(["Включить терминатор 120 Ом", false, false]);
  expect(t2.disabled).toBe(true);
  t1.run();
  expect(calls).toEqual([{ type: "channel_terminator", args: { channel: 1, enabled: true } }]);
});

test("closed channel submenu is disabled", () => {
  applyEvent({
    type: "status",
    state: "opened",
    message: "",
    device_info: { channel_features: { "1": { terminator: true } } },
    channels: { "1": chan({ open: false }) },
  });
  const [sub] = channelMenu().filter((i): i is Sub => "items" in i);
  expect(sub.disabled).toBe(true);
});
