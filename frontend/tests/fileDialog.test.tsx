// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const calls: { type: string; args: Record<string, unknown> }[] = [];
vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: (type: string, args: Record<string, unknown> = {}) => {
    calls.push({ type, args });
    if (type === "files_list") {
      return Promise.resolve({ files: [{ name: "drive.trc", size: 2048, mtime: 1_760_000_000 }] });
    }
    return Promise.resolve({});
  },
}));

import { FileDialog, validFileName } from "../src/features/files/FileDialog";

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => cleanup());

test("save dialog validates name", () => {
  expect(validFileName("drive 1")).toBe(true);
  expect(validFileName("поездка-01")).toBe(true);
  expect(validFileName("")).toBe(false);
  expect(validFileName("../x")).toBe(false);
  expect(validFileName(".hidden")).toBe(false);
  expect(validFileName("a/b")).toBe(false);
});

test("open dialog lists files and returns the picked name", async () => {
  let picked = "";
  render(<FileDialog mode="open" kind="traces" title="Открыть" onPick={(n) => (picked = n)} onClose={() => {}} />);
  const item = await screen.findByText("drive.trc");
  fireEvent.click(item);
  fireEvent.click(screen.getByText("Открыть", { selector: "button" }));
  expect(picked).toBe("drive.trc");
  expect(calls[0]).toEqual({ type: "files_list", args: { kind: "traces" } });
});

test("save dialog refuses bad name and offers format", async () => {
  let picked = "";
  let format = "";
  render(
    <FileDialog mode="save" kind="traces" title="Сохранить" defaultName="поток" withFormat
      onPick={(n, f) => { picked = n; format = f ?? ""; }} onClose={() => {}} />,
  );
  const name = await screen.findByLabelText("Имя файла");
  fireEvent.input(name, { target: { value: "../плохо" } });
  fireEvent.click(screen.getByText("Сохранить", { selector: "button" }));
  expect(picked).toBe("");
  expect(screen.getByText("Недопустимое имя файла")).toBeTruthy();
  fireEvent.input(name, { target: { value: "поездка" } });
  fireEvent.click(screen.getByText("Сохранить", { selector: "button" }));
  expect(picked).toBe("поездка");
  expect(format).toBe("trc");
});
