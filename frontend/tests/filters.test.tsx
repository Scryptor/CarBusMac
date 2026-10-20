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

import { applyEvent, resetStore } from "../src/core/store";
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
