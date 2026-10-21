// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, expect, test } from "vitest";
import { Dialog, modalCount } from "../src/ui/Dialog";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const dialogEl = (name: string) => screen.getByRole("dialog", { name }) as HTMLElement;

test("a click on the backdrop keeps focus in the dialog; keys reach it even if focus was lost", () => {
  let closed = 0;
  let ok = 0;
  render(
    <Dialog title="Окно" onClose={() => closed++} onOk={() => ok++}>
      <input aria-label="поле" />
    </Dialog>,
  );
  const overlay = document.querySelector(".overlay")!;
  // браузер увёл бы фокус на body — отменяем действие по умолчанию
  expect(fireEvent.mouseDown(overlay)).toBe(false);
  expect(document.activeElement).toBe(screen.getByLabelText("поле"));
  // фокус всё же потерян (элемент удалили) — Esc/Enter достаются окну
  act(() => (document.activeElement as HTMLElement).blur());
  expect(document.activeElement).toBe(document.body);
  fireEvent.keyDown(document.body, { key: "Enter" });
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect([ok, closed]).toEqual([1, 1]);
});

function Nested(p: { parentClose: () => void; parentOk: () => void; childClose: () => void; childOk: () => void }) {
  return (
    <Dialog title="Настройки устройства" onClose={p.parentClose} onOk={p.parentOk}>
      <input aria-label="поле родителя" />
      <Dialog title="Управление скоростями" onClose={p.childClose} onOk={p.childOk}>
        <input aria-label="поле вложенного" />
      </Dialog>
    </Dialog>
  );
}

test("nested dialog: Escape and Enter belong to the top one even when focus sits on the parent", () => {
  const n = { parentClose: 0, parentOk: 0, childClose: 0, childOk: 0 };
  render(
    <Nested
      parentClose={() => n.parentClose++}
      parentOk={() => n.parentOk++}
      childClose={() => n.childClose++}
      childOk={() => n.childOk++}
    />,
  );
  expect(document.activeElement).toBe(screen.getByLabelText("поле вложенного"));
  // клик по подложке вложенного окна: фокус не уходит родителю
  const inner = dialogEl("Управление скоростями").parentElement!;
  expect(fireEvent.mouseDown(inner)).toBe(false);
  // фокус оказался на родителе (как было до исправления) — Enter не «принимает» родителя
  act(() => dialogEl("Настройки устройства").focus());
  fireEvent.keyDown(dialogEl("Настройки устройства"), { key: "Enter" });
  expect(n.parentOk).toBe(0);
  fireEvent.keyDown(dialogEl("Настройки устройства"), { key: "Escape" });
  expect([n.childClose, n.parentClose]).toEqual([1, 0]);
});

test("keys typed in a nested dialog do not bubble to the parent dialog", () => {
  render(<Nested parentClose={() => {}} parentOk={() => {}} childClose={() => {}} childOk={() => {}} />);
  const seen: string[] = [];
  dialogEl("Настройки устройства").addEventListener("keydown", (e) => seen.push(e.key));
  fireEvent.keyDown(screen.getByLabelText("поле вложенного"), { key: "a" });
  fireEvent.keyDown(screen.getByLabelText("поле вложенного"), { key: "Escape" });
  expect(seen).toEqual([]);
});

test("Tab cycles inside the dialog and the rest of the app is inert while it is open", () => {
  function App() {
    const [open, setOpen] = useState(true);
    return (
      <div class="app">
        <button type="button">Старт</button>
        {open ? (
          <Dialog title="Окно" onClose={() => setOpen(false)} onOk={() => {}}>
            <input aria-label="поле" />
          </Dialog>
        ) : null}
      </div>
    );
  }
  render(<App />);
  const start = screen.getByText("Старт");
  expect(start.closest("[inert]")).not.toBeNull();
  const dlg = dialogEl("Окно");
  const buttons = [...dlg.querySelectorAll("button")];
  const first = buttons[0]; // «Закрыть» в заголовке
  const last = buttons[buttons.length - 1]; // «Принять»
  act(() => last.focus());
  expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
  expect(document.activeElement).toBe(first);
  expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(last);
  // внутри — обычный Tab браузера
  act(() => screen.getByLabelText("поле").focus());
  expect(fireEvent.keyDown(screen.getByLabelText("поле"), { key: "Tab" })).toBe(true);
  fireEvent.keyDown(screen.getByLabelText("поле"), { key: "Escape" });
  expect(start.closest("[inert]")).toBeNull();
  expect(modalCount.value).toBe(0);
});

test("fields of a collapsed <details> get neither the first focus nor Tab", () => {
  render(
    <Dialog title="Окно" onClose={() => {}} onOk={() => {}}>
      <details>
        <summary>Дополнительно</summary>
        <input aria-label="скрытое" />
      </details>
      <input aria-label="видимое" />
    </Dialog>,
  );
  expect(document.activeElement).toBe(screen.getByLabelText("видимое"));
  // Tab с заголовка свёрнутого блока идёт к следующему видимому полю, а не застревает на скрытом
  const summary = screen.getByText("Дополнительно");
  act(() => summary.focus());
  fireEvent.keyDown(summary, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByLabelText("видимое"));
});

test("focus returns to the element that opened the dialog", async () => {
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  const { unmount } = render(
    <Dialog title="Окно" onClose={() => {}}>
      <input aria-label="поле" />
    </Dialog>,
  );
  expect(document.activeElement).toBe(screen.getByLabelText("поле"));
  unmount();
  await Promise.resolve(); // фокус возвращается, когда окно уже снято с DOM
  expect(document.activeElement).toBe(opener);
});

test("Enter on a link or a button does its own job instead of «Принять»", () => {
  let ok = 0;
  render(
    <Dialog
      title="Файлы"
      onClose={() => {}}
      onOk={() => ok++}
      footerLeft={
        <a class="btn" href="/api/files/x" download="x">
          Скачать
        </a>
      }
    >
      <input aria-label="имя" />
      <label>
        <input type="checkbox" aria-label="флажок" />
      </label>
      <button type="button">Обзор</button>
      <textarea aria-label="текст" />
    </Dialog>,
  );
  fireEvent.keyDown(screen.getByText("Скачать"), { key: "Enter" });
  fireEvent.keyDown(screen.getByText("Обзор"), { key: "Enter" });
  fireEvent.keyDown(screen.getByLabelText("текст"), { key: "Enter" });
  expect(ok).toBe(0);
  fireEvent.keyDown(screen.getByLabelText("имя"), { key: "Enter" });
  fireEvent.keyDown(screen.getByLabelText("флажок"), { key: "Enter" });
  fireEvent.keyDown(dialogEl("Файлы"), { key: "Enter" });
  expect(ok).toBe(3);
});

test("closing a nested dialog returns focus to its opener inside the parent", async () => {
  function Parent() {
    const [child, setChild] = useState(false);
    return (
      <Dialog title="Родитель" onClose={() => {}}>
        <button type="button" onClick={() => setChild(true)}>
          Настроить скорости
        </button>
        {child ? (
          <Dialog title="Вложенное" onClose={() => setChild(false)}>
            <input aria-label="скорость" />
          </Dialog>
        ) : null}
      </Dialog>
    );
  }
  render(<Parent />);
  const btn = screen.getByText("Настроить скорости");
  act(() => btn.focus());
  fireEvent.click(btn);
  expect(document.activeElement).toBe(screen.getByLabelText("скорость"));
  expect(btn.closest("[inert]")).not.toBeNull(); // содержимое родителя недоступно
  fireEvent.keyDown(screen.getByLabelText("скорость"), { key: "Escape" });
  await Promise.resolve();
  expect(screen.queryByRole("dialog", { name: "Вложенное" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Родитель" })).toBeTruthy();
  expect(btn.closest("[inert]")).toBeNull();
  expect(document.activeElement).toBe(btn);
});

test("a dialog that replaces another one in the same render returns focus to the first opener", async () => {
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  function Flow() {
    const [step, setStep] = useState(1);
    if (step === 1)
      return (
        <Dialog key="a" title="Шаг 1" onClose={() => setStep(0)} onOk={() => setStep(2)}>
          <input aria-label="шаг 1" />
        </Dialog>
      );
    if (step === 2)
      return (
        <Dialog key="b" title="Шаг 2" onClose={() => setStep(0)} onOk={() => setStep(0)}>
          <p>Уверены?</p>
        </Dialog>
      );
    return null;
  }
  opener.focus();
  render(<Flow />);
  fireEvent.keyDown(screen.getByLabelText("шаг 1"), { key: "Enter" });
  expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Шаг 2" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await Promise.resolve();
  expect(document.activeElement).toBe(opener);
});
