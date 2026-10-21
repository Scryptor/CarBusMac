// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, expect, test } from "vitest";
import { FloatingWindow } from "../src/ui/FloatingWindow";

afterEach(() => cleanup());

const win = (id: string) => (
  <FloatingWindow id={id} title={id} width={300} initial={{ x: 10, y: 10 }} onClose={() => {}}>
    <p>{id}</p>
  </FloatingWindow>
);

const z = (el: HTMLElement) => Number(el.style.zIndex);

test("floating windows stay under dialogs (900) and menus (1000) however often they are clicked", () => {
  const { container } = render(
    <>
      {win("a")}
      {win("b")}
    </>,
  );
  const [a, b] = [...container.querySelectorAll<HTMLElement>(".float")];
  for (let n = 0; n < 600; n++) fireEvent.mouseDown(n % 2 ? a : b);
  expect(Math.max(z(a), z(b))).toBeLessThan(900);
  expect(z(a)).toBeGreaterThan(z(b)); // последним кликнули по «a» — оно сверху
  fireEvent.mouseDown(b);
  expect(z(b)).toBeGreaterThan(z(a));
});

test("a click on the top window does not change the order; a closed window leaves no gap", () => {
  function Host() {
    const [open, setOpen] = useState(["a", "b", "c"]);
    return (
      <>
        <button type="button" onClick={() => setOpen(open.filter((x) => x !== "a"))}>
          закрыть a
        </button>
        {open.map((id) => win(id))}
      </>
    );
  }
  const { container, getByText } = render(<Host />);
  const els = () => [...container.querySelectorAll<HTMLElement>(".float")];
  const before = els().map(z);
  fireEvent.mouseDown(els()[2]); // «c» и так сверху
  expect(els().map(z)).toEqual(before);
  fireEvent.click(getByText("закрыть a"));
  expect(els().map(z)).toEqual([500, 501]);
});
