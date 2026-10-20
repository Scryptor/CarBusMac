// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: () => Promise.resolve({}),
}));

import type { TracerRowJson } from "../src/core/types";
import { RowEditorDialog } from "../src/features/tracer/RowEditorDialog";

afterEach(() => cleanup());

const base: TracerRowJson = {
  i: 41,
  pos: 40,
  t: 1.2,
  ch: 2,
  dir: "rx",
  id: 0x7e0,
  ext: false,
  rtr: false,
  dlc: 2,
  data: "0201",
  marker: null,
  enabled: true,
  bp: true,
  start: false,
  finish: false,
  before_ms: 0,
  after_ms: 0,
  comment: "",
};
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

test("row editor validates and emits row", () => {
  const onSubmit = vi.fn();
  render(<RowEditorDialog mode="edit" base={base} onSubmit={onSubmit} onClose={() => {}} />);
  expect(screen.getByRole("dialog", { name: "Отредактировать строку" })).toBeTruthy();
  fireEvent.input(field("ID"), { target: { value: "7FF0" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(screen.getByText(/ID вне диапазона/)).toBeTruthy();
  expect(onSubmit).not.toHaveBeenCalled();

  fireEvent.input(field("ID"), { target: { value: "7E8" } });
  fireEvent.change(screen.getByLabelText("DLC"), { target: { value: "3" } });
  fireEvent.input(field("Данные 2"), { target: { value: "FF" } });
  fireEvent.input(field("Пауза перед, мс"), { target: { value: "50" } });
  fireEvent.input(field("Пауза после, мс"), { target: { value: "1001" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(screen.getByText("Пауза после, мс: от 0 до 1000")).toBeTruthy();

  fireEvent.input(field("Пауза после, мс"), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(onSubmit).toHaveBeenCalledWith({
    ch: 2,
    id: 0x7e8,
    ext: false,
    rtr: false,
    data: "0201ff",
    before_ms: 50,
    after_ms: 30,
  });
});

test("value fills the active data bytes", () => {
  const onSubmit = vi.fn();
  render(<RowEditorDialog mode="add" base={null} onSubmit={onSubmit} onClose={() => {}} />);
  expect(screen.getByRole("dialog", { name: "Добавить строку" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("DLC"), { target: { value: "4" } });
  fireEvent.input(field("Значение"), { target: { value: "AA" } });
  fireEvent.click(screen.getByRole("button", { name: "Заполнить" }));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(onSubmit.mock.calls[0][0].data).toBe("aaaaaaaa");
});
