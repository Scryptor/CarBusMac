// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { calls, listing } = vi.hoisted(() => ({
  calls: [] as { type: string; args: Record<string, unknown> }[],
  listing: { files: [] as { name: string; size: number; mtime: number }[] },
}));
vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: (type: string, args: Record<string, unknown> = {}) => {
    calls.push({ type, args });
    if (type === "files_list") return Promise.resolve({ files: listing.files });
    return Promise.resolve({});
  },
}));

import { FileDialog, savedName, validFileName } from "../src/features/files/FileDialog";

const file = (name: string) => ({ name, size: 2048, mtime: 1_760_000_000 });
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  calls.length = 0;
  listing.files = [file("drive.trc")];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

test("savedName adds the format's extension unless the name already has an allowed one", () => {
  expect(savedName("поездка", "traces", ".trc")).toBe("поездка.trc");
  expect(savedName("поездка 20.10.2026", "traces", ".trc")).toBe("поездка 20.10.2026.trc");
  expect(savedName("drive.JSONL", "traces", ".trc")).toBe("drive.JSONL");
  expect(savedName("набор", "lists", ".json")).toBe("набор.json");
});

test("saving over an existing file asks first; «Нет» keeps the dialog with the typed name", async () => {
  let picked = "";
  render(<FileDialog mode="save" kind="traces" title="Сохранить" defaultName="поток" withFormat onPick={(n) => (picked = n)} onClose={() => {}} />);
  await screen.findByText("drive.trc");
  const name = screen.getByLabelText("Имя файла") as HTMLInputElement;
  fireEvent.input(name, { target: { value: "drive" } });
  fireEvent.click(screen.getByText("Сохранить", { selector: "button" }));
  expect(await screen.findByText("Файл «drive.trc» уже существует. Заменить?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Нет" }));
  await tick();
  expect(picked).toBe("");
  expect(screen.queryByText("Файл «drive.trc» уже существует. Заменить?")).toBeNull();
  expect((screen.getByLabelText("Имя файла") as HTMLInputElement).value).toBe("drive");
  expect(document.activeElement).toBe(screen.getByLabelText("Имя файла")); // Enter/Esc снова доходят до диалога
  fireEvent.click(screen.getByText("Сохранить", { selector: "button" }));
  fireEvent.click(await screen.findByRole("button", { name: "Да" }));
  await tick();
  expect(picked).toBe("drive");
});

test("a new name is saved without a question", async () => {
  let picked = "";
  render(<FileDialog mode="save" kind="traces" title="Сохранить" defaultName="поток" withFormat onPick={(n) => (picked = n)} onClose={() => {}} />);
  await screen.findByText("drive.trc");
  fireEvent.click(screen.getByText("Сохранить", { selector: "button" }));
  await tick();
  expect(picked).toBe("поток");
});

test("uploading a file that is already there asks before replacing it", async () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ name: "drive.trc" }), { status: 200 })));
  vi.stubGlobal("fetch", fetchMock);
  render(<FileDialog mode="open" kind="traces" title="Открыть" onPick={() => {}} onClose={() => {}} />);
  await screen.findByText("drive.trc");
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x"], "drive.trc")] } });
  fireEvent.click(await screen.findByRole("button", { name: "Нет" }));
  await tick();
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { files: [new File(["x"], "drive.trc")] } });
  fireEvent.click(await screen.findByRole("button", { name: "Да" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  fireEvent.change(input, { target: { files: [new File(["x"], "new.trc")] } }); // нового файла нет — без вопроса
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

test("picking a file to overwrite keeps dots in its name and takes its format", async () => {
  listing.files = [file("my trace v1.2.jsonl")];
  let picked = "";
  let format = "";
  render(
    <FileDialog mode="save" kind="traces" title="Сохранить" defaultName="поток" withFormat
      onPick={(n, f) => { picked = n; format = f ?? ""; }} onClose={() => {}} />,
  );
  fireEvent.click(await screen.findByText("my trace v1.2.jsonl"));
  expect((screen.getByLabelText("Имя файла") as HTMLInputElement).value).toBe("my trace v1.2");
  expect((screen.getByLabelText("Формат") as HTMLSelectElement).value).toBe("jsonl");
  fireEvent.click(screen.getByText("Сохранить", { selector: "button" }));
  fireEvent.click(await screen.findByRole("button", { name: "Да" }));
  await tick();
  expect([picked, format]).toEqual(["my trace v1.2", "jsonl"]);
});

test("save dialog can start from a given format", async () => {
  render(<FileDialog mode="save" kind="traces" title="Сохранить" defaultName="поток" withFormat defaultFormat="jsonl" onPick={() => {}} onClose={() => {}} />);
  expect((screen.getByLabelText("Формат") as HTMLSelectElement).value).toBe("jsonl");
});

test("open dialog focuses the file list: arrows pick, Enter opens, Escape closes", async () => {
  listing.files = [file("a.trc"), file("b.trc")];
  let picked = "";
  const onClose = vi.fn();
  render(<FileDialog mode="open" kind="traces" title="Открыть" onPick={(n) => (picked = n)} onClose={onClose} />);
  await screen.findByText("b.trc");
  await tick();
  const list = screen.getByRole("listbox", { name: "Файлы" });
  expect(document.activeElement).toBe(list);
  fireEvent.keyDown(list, { key: "ArrowDown" });
  fireEvent.keyDown(list, { key: "ArrowDown" });
  fireEvent.keyDown(list, { key: "Enter" });
  expect(picked).toBe("b.trc");
  fireEvent.keyDown(list, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});
