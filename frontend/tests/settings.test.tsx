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

import { resetStore, store } from "../src/core/store";
import { applyTheme } from "../src/core/theme";
import { SettingsDialog, strftimePreview } from "../src/features/settings/SettingsDialog";

beforeEach(() => {
  resetStore();
  calls.length = 0;
  store.settings.value = { ...store.settings.value, theme: "light" };
  applyTheme(store.settings.value);
});
afterEach(() => cleanup());

const root = () => document.documentElement;

test("settings dialog applies theme", () => {
  const onClose = vi.fn();
  render(<SettingsDialog onClose={onClose} />);
  fireEvent.change(screen.getByLabelText("Стиль"), { target: { value: "dark" } });
  expect(root().dataset.theme).toBe("dark");
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  expect(onClose).toHaveBeenCalled();
  expect(calls).toEqual([{ type: "settings_set", args: { patch: expect.objectContaining({ theme: "dark" }) } }]);
});

test("cancel brings back the previous look", () => {
  const onClose = vi.fn();
  render(<SettingsDialog onClose={onClose} initialTab="font" />);
  fireEvent.change(screen.getByLabelText("Размер:"), { target: { value: "16" } });
  expect(root().style.getPropertyValue("--grid-size")).toBe("16px");
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(root().style.getPropertyValue("--grid-size")).toBe("13px");
  expect(calls).toEqual([]);
});

test("log tab edits meta and previews the file name", () => {
  render(<SettingsDialog onClose={() => {}} initialTab="log" />);
  fireEvent.input(screen.getByLabelText("Марка"), { target: { value: "Lada" } });
  fireEvent.input(screen.getByLabelText("Маска имени файла"), { target: { value: "vesta_%Y" } });
  expect(screen.getByText(/vesta_\d{4}\.trc/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  const patch = calls[0].args.patch as Record<string, unknown>;
  expect(patch.log_name_mask).toBe("vesta_%Y");
  expect(patch.log_meta).toEqual({ transport: "", brand: "Lada", model: "", body: "", year: "" });
});

test("hold time outside 500..10000 is rejected with a message", () => {
  render(<SettingsDialog onClose={() => {}} initialTab="receive" />);
  fireEvent.input(screen.getByLabelText("Сбросить после"), { target: { value: "100" } });
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  expect(screen.getByText("Сбросить после: от 500 до 10000")).toBeTruthy();
  expect(calls).toEqual([]);
});

test("strftimePreview formats the common codes", () => {
  const d = new Date(2026, 9, 20, 7, 5, 9);
  expect(strftimePreview("%Y-%m-%d_%H-%M-%S", d)).toBe("2026-10-20_07-05-09");
  expect(strftimePreview("trip %y%%", d)).toBe("trip 26%");
});
