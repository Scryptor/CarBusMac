// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, expect, test } from "vitest";
import { ByteCells } from "../src/ui/Fields";

afterEach(() => cleanup());

type Bytes = (number | null)[];

/** Родитель как редактор передачи: значение из onChange возвращается в ByteCells. */
function Host({ initial, allowEmpty, onValue }: { initial: Bytes; allowEmpty?: boolean; onValue?: (v: Bytes) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ByteCells
        count={4}
        value={value}
        allowEmpty={allowEmpty}
        label="Данные"
        onChange={(v) => {
          setValue(v);
          onValue?.(v);
        }}
      />
      <button type="button" onClick={() => setValue([7, 7, 7, 7])}>
        внешнее
      </button>
    </>
  );
}

/** Нажатие символа как в браузере: текст встаёт на место выделения, длиннее maxLength
 * поле не становится — лишний символ браузер просто отбрасывает. */
function typeChar(el: HTMLInputElement, ch: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = el.value.slice(0, start) + ch + el.value.slice(end);
  if (el.maxLength >= 0 && next.length > el.maxLength) return;
  fireEvent.input(el, { target: { value: next } });
}

const cells = () => screen.getAllByRole("textbox") as HTMLInputElement[];

test("two-digit hex byte is typed digit by digit when the parent feeds the value back", () => {
  let last: Bytes = [];
  render(<Host initial={[0, 0, 0, 0]} onValue={(v) => (last = v)} />);
  const c = cells();
  act(() => c[0].focus()); // фокус выделяет текст ячейки — первая цифра его заменяет
  typeChar(c[0], "A");
  expect(last).toEqual([0x0a, 0, 0, 0]);
  expect(c[0].value).toBe("A"); // не «0A»: иначе поле заполнено и вторая цифра отброшена
  typeChar(c[0], "5");
  expect(last).toEqual([0xa5, 0, 0, 0]);
  expect(document.activeElement).toBe(c[1]); // вторая цифра переводит фокус дальше
  typeChar(c[1], "F");
  typeChar(c[1], "F");
  expect(last).toEqual([0xa5, 0xff, 0, 0]);
  expect(c[0].value).toBe("A5");
});

test("a leading zero goes into an empty don't-care trigger cell", () => {
  let last: Bytes = [];
  render(<Host initial={[null, null, null, null]} allowEmpty onValue={(v) => (last = v)} />);
  const c = cells();
  act(() => c[2].focus());
  typeChar(c[2], "0");
  typeChar(c[2], "5");
  expect(last).toEqual([null, null, 0x05, null]);
});

test("a single digit is shown as two once the cell loses focus", () => {
  render(<Host initial={[0, 0, 0, 0]} />);
  const c = cells();
  act(() => c[0].focus());
  typeChar(c[0], "A");
  act(() => c[3].focus());
  expect(c[0].value).toBe("0A");
});

test("paste into the focused cell spreads the bytes and shows them", () => {
  render(<Host initial={[0, 0, 0, 0]} />);
  const c = cells();
  act(() => c[1].focus());
  fireEvent.paste(c[1], { clipboardData: { getData: () => "0A 0B 0C" } });
  expect(c.map((x) => x.value)).toEqual(["00", "0A", "0B", "0C"]);
});

/** Вставка как в браузере: если обработчик её не отменил, текст встаёт на место выделения
 * (лишнее сверх maxLength отбрасывается) и приходит input. */
function pasteText(el: HTMLInputElement, text: string) {
  if (!fireEvent.paste(el, { clipboardData: { getData: () => text } })) return; // отменена
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const room = el.maxLength >= 0 ? el.maxLength - (el.value.length - (end - start)) : text.length;
  fireEvent.input(el, { target: { value: el.value.slice(0, start) + text.slice(0, Math.max(0, room)) + el.value.slice(end) } });
}

test("pasting text that is not hex leaves the byte as it was", () => {
  let last: Bytes | null = null;
  render(<Host initial={[0, 0x11, 0, 0]} onValue={(v) => (last = v)} />);
  const c = cells();
  act(() => c[1].focus()); // фокус выделяет текст ячейки
  pasteText(c[1], "hello world"); // без отмены браузер вставил бы «he», а фильтр оставил бы 0E
  expect(last).toBe(null);
  expect(c.map((x) => x.value)).toEqual(["00", "11", "00", "00"]);
  pasteText(c[1], "0A0B0C"); // hex по-прежнему разбирается по байтам
  expect(c.map((x) => x.value)).toEqual(["00", "0A", "0B", "0C"]);
  expect(last).toEqual([0, 0x0a, 0x0b, 0x0c]);
});

test("an outside change reaches every cell; the one being typed in catches up on blur", () => {
  render(<Host initial={[0, 0, 0, 0]} />);
  const c = cells();
  act(() => c[0].focus());
  typeChar(c[0], "A");
  fireEvent.click(screen.getByRole("button", { name: "внешнее" }));
  expect(c.slice(1).map((x) => x.value)).toEqual(["07", "07", "07"]);
  expect(c[0].value).toBe("A"); // в ячейке печатают — текст не выдёргиваем
  act(() => c[0].blur());
  expect(c[0].value).toBe("07");
});

test("fast typing: the second digit arrives before effects run and the cell keeps «A5»", async () => {
  // в браузере обычный эффект Preact выполняется после кадра, а вторая цифра приходит раньше
  let last: Bytes = [];
  render(<Host initial={[0, 0, 0, 0]} onValue={(v) => (last = v)} />);
  const c = cells();
  act(() => c[0].focus());
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const typeRaw = async (el: HTMLInputElement, v: string) => {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true })); // без act: эффекты не сбрасываются
    await Promise.resolve();
    await Promise.resolve();
  };
  await typeRaw(c[0], "A");
  await typeRaw(c[0], "A5");
  expect(document.activeElement).toBe(c[1]);
  expect(last).toEqual([0xa5, 0, 0, 0]);
  expect(c[0].value).toBe("A5");
  await tick();
  expect(c[0].value).toBe("A5");
});
