// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
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
import type { RangeFilterJson } from "../src/core/types";
import { ExclusionDialog, HwFilterDialog, RangeFilterDialog } from "../src/features/filters/dialogs";
import { FiltersPanel } from "../src/features/filters/FiltersPanel";

beforeEach(() => {
  resetStore();
  calls.length = 0;
  applyEvent({
    type: "filters_state",
    hw_layout: { "1": 2, "2": 1 },
    hw: [
      { channel: 1, index: 0, enabled: false, can_id: 0x7e8, mask: 0x7ff, ext: false },
      { channel: 1, index: 1, enabled: false, can_id: 0, mask: 0x7ff, ext: false },
      { channel: 2, index: 0, enabled: false, can_id: 0, mask: 0x7ff, ext: false },
    ],
    ranges: [{ id: "r1", channel: 1, enabled: true, start: 0x100, end: 0x1ff, exclusions: [{ enabled: true, can_id: 0x120, mask: 0x7ff }] }],
  });
});
afterEach(() => cleanup());

test("checkbox toggles hw slot", async () => {
  render(<FiltersPanel />);
  const box = await screen.findByLabelText("Включить фильтр 1/0");
  fireEvent.click(box);
  expect(calls).toContainEqual({
    type: "hw_set",
    args: { slot: { channel: 1, index: 0, enabled: true, can_id: 0x7e8, mask: 0x7ff, ext: false } },
  });
});

test("range tab lists ranges with exclusions and toggles a range", async () => {
  render(<FiltersPanel />);
  fireEvent.click(screen.getByRole("tab", { name: "Фильтр Диапазон" }));
  expect(await screen.findByText("Канал 1: С 100 по 1FF")).toBeTruthy();
  expect(screen.getByText("Исключить Id: 120 / Маска: 7FF")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Включить: Канал 1: С 100 по 1FF"));
  const up = calls.find((c) => c.type === "range_upsert");
  expect((up?.args.filter as { enabled: boolean }).enabled).toBe(false);
});

const sentRange = () => calls.find((c) => c.type === "range_upsert")?.args.filter as RangeFilterJson;

test("a new range spans up to 1FFFFFFF like the desktop, so 29-bit traffic is not cut off", () => {
  render(<RangeFilterDialog range={null} />);
  expect((screen.getByLabelText("По") as HTMLInputElement).value).toBe("1FFFFFFF");
  fireEvent.click(screen.getByRole("button", { name: "Установить" }));
  expect(sentRange().end).toBe(0x1fffffff);
});

test("an ID typed into the exclude list gets a 29-bit mask (exact match)", () => {
  render(<RangeFilterDialog range={store.filters.value.ranges[0]} />);
  fireEvent.input(screen.getByLabelText("Список исключённых идентификаторов"), { target: { value: "120, 110" } });
  fireEvent.click(screen.getByRole("button", { name: "Установить" }));
  expect(sentRange().exclusions).toEqual([
    { enabled: true, can_id: 0x120, mask: 0x7ff }, // прежнее исключение — со своей маской
    { enabled: true, can_id: 0x110, mask: 0x1fffffff },
  ]);
});

test("in simple mode the hidden mask of an exclusion covers all 29 bits", () => {
  applyEvent({ type: "settings", settings: { filter_simple_mode: true } });
  render(<ExclusionDialog range={store.filters.value.ranges[0]} index={null} />);
  fireEvent.input(screen.getByLabelText("ID"), { target: { value: "110" } });
  fireEvent.click(screen.getByRole("button", { name: "Установить" }));
  expect(sentRange().exclusions.at(-1)).toEqual({ enabled: true, can_id: 0x110, mask: 0x1fffffff });
});

test("outside simple mode a new exclusion starts with the desktop's mask 7FF and sends what is typed", () => {
  render(<ExclusionDialog range={store.filters.value.ranges[0]} index={null} />);
  expect((screen.getByLabelText("Маска") as HTMLInputElement).value).toBe("7FF");
  fireEvent.input(screen.getByLabelText("ID"), { target: { value: "110" } });
  fireEvent.input(screen.getByLabelText("Маска"), { target: { value: "1FFFFFFF" } });
  fireEvent.click(screen.getByRole("button", { name: "Установить" }));
  expect(sentRange().exclusions.at(-1)).toEqual({ enabled: true, can_id: 0x110, mask: 0x1fffffff });
});


test("hw slot of an 11-bit-only bank cannot be switched to 29 bit", () => {
  render(<HwFilterDialog slot={{ channel: 1, index: 0, enabled: false, can_id: 0, mask: 0x7ff, ext: false, kind: "std" }} />);
  const box = screen.getByLabelText("29 bit фильтр") as HTMLInputElement;
  expect(box.disabled).toBe(true);
  expect(box.checked).toBe(false);
});

test("untouched hw slot follows the «new filter is active» setting", () => {
  applyEvent({ type: "settings", settings: { ...store.settings.value, filter_new_active: false } });
  render(<HwFilterDialog slot={{ channel: 1, index: 1, enabled: false, can_id: 0, mask: 0x7ff, ext: false }} />);
  expect((screen.getByLabelText("Включить фильтр") as HTMLInputElement).checked).toBe(false);
});
