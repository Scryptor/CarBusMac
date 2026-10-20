import { expect, test } from "vitest";
import { Selection } from "../src/ui/grid/selection";

test("click selects one row and sets anchor", () => {
  const s = new Selection();
  s.click(5);
  expect(s.selected()).toEqual([5]);
  s.click(2);
  expect(s.selected()).toEqual([2]);
  expect(s.focus).toBe(2);
});

test("shift range from anchor", () => {
  const s = new Selection();
  s.click(3);
  s.shiftClick(6);
  expect(s.selected()).toEqual([3, 4, 5, 6]);
  s.shiftClick(1);
  expect(s.selected()).toEqual([1, 2, 3]);
});

test("ctrl toggle adds and removes single rows", () => {
  const s = new Selection();
  s.click(1);
  s.ctrlClick(4);
  s.ctrlClick(7);
  expect(s.selected()).toEqual([1, 4, 7]);
  s.ctrlClick(4);
  expect(s.selected()).toEqual([1, 7]);
});

test("keyboard move clamps and extends with shift", () => {
  const s = new Selection();
  s.click(0);
  s.move(1, 10, false);
  expect(s.selected()).toEqual([1]);
  s.move(2, 10, true);
  expect(s.selected()).toEqual([1, 2, 3]);
  s.move(100, 10, false);
  expect(s.selected()).toEqual([9]);
  s.move(-100, 10, false);
  expect(s.selected()).toEqual([0]);
});

test("clear and clamp after rows removed", () => {
  const s = new Selection();
  s.click(2);
  s.shiftClick(8);
  s.clamp(5);
  expect(s.selected()).toEqual([2, 3, 4]);
  s.clear();
  expect(s.selected()).toEqual([]);
  expect(s.focus).toBeNull();
});

test("addMany and removeMany change the set without moving the cursor", () => {
  const s = new Selection();
  s.click(2);
  s.addMany([5, 7, 2]);
  expect(s.selected()).toEqual([2, 5, 7]);
  expect(s.focus).toBe(2);
  s.removeMany([2, 7]);
  expect(s.selected()).toEqual([5]);
});
