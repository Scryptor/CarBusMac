import { expect, test } from "vitest";
import { FieldError, fillData, newTask, nextTaskId, parseTaskForm, taskFromRow, taskToForm } from "../src/features/transmit/txModel";

const base = newTask("t1");

function form(over: Partial<ReturnType<typeof taskToForm>> = {}) {
  return { ...taskToForm(base), ...over };
}

function fieldOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof FieldError) return e.field;
    throw e;
  }
  return "";
}

test("newTask has desktop defaults", () => {
  expect(base).toMatchObject({ id: "t1", channel: 1, can_id: 0, ext: false, data: "0000000000000000", period_ms: 10 });
  expect(base.trigger.action).toBe("none");
});

test("parseTaskForm rejects bad id/dlc/period with field name", () => {
  expect(fieldOf(() => parseTaskForm(form({ id: "800" }), base))).toBe("id");
  expect(fieldOf(() => parseTaskForm(form({ dlc: "9" }), base))).toBe("dlc");
  expect(fieldOf(() => parseTaskForm(form({ period: "0" }), base))).toBe("period");
  expect(fieldOf(() => parseTaskForm(form({ trigAction: "single", trigId: "" }), base))).toBe("trigId");
  expect(fieldOf(() => parseTaskForm(form({ trigAction: "single", trigId: "7E8", trigDelay: "20000" }), base))).toBe("trigDelay");
});

test("parseTaskForm builds task json, data trimmed to DLC", () => {
  const t = parseTaskForm(form({ id: "7e0", dlc: "3", data: [2, 0x3e, 0, 9, 9, 9, 9, 9], period: "500", comment: "tester" }), base);
  expect(t).toMatchObject({ can_id: 0x7e0, data: "023e00", period_ms: 500, comment: "tester", channel: 1 });
});

test("empty trigger byte means dont-care", () => {
  const t = parseTaskForm(
    form({ trigAction: "start", trigId: "7E8", trigCh: "2", trigDlc: "", trigData: [0x10, null, null, null, null, null, null, null] }),
    base,
  );
  expect(t.trigger).toEqual({ action: "start", delay_ms: 0, channel: 2, can_id: 0x7e8, ext: false, dlc: null,
    data: [0x10, null, null, null, null, null, null, null] });
});

test("fillData repeats one byte across DLC", () => {
  expect(fillData("aa", 3)).toEqual([0xaa, 0xaa, 0xaa]);
  expect(() => fillData("zz", 2)).toThrow();
});

test("nextTaskId never collides with loaded lists", () => {
  expect(nextTaskId([{ ...base, id: "t1" }, { ...base, id: "t7" }])).toBe("t8");
  expect(nextTaskId([])).toBe("t1");
});

test("taskFromRow copies a received message", () => {
  const t = taskFromRow({ ch: 2, id: 0x18daf110, ext: true, rtr: false, data: "027e00" }, "t3", "ответ");
  expect(t).toMatchObject({ id: "t3", channel: 2, can_id: 0x18daf110, ext: true, data: "027e00", comment: "ответ" });
});

test("an RTR task keeps its DLC but no data", () => {
  const t = parseTaskForm(form({ rtr: true, dlc: "3", data: [1, 2, 3, 4, 5, 6, 7, 8] }), base);
  expect(t).toMatchObject({ rtr: true, data: "000000" });
});

test("trigger bytes beyond the trigger DLC are don't-care", () => {
  const t = parseTaskForm(form({ trigAction: "single", trigId: "7E8", trigDlc: "2", trigData: [1, 2, 3, null, 5, null, null, 8] }), base);
  expect(t.trigger.data).toEqual([1, 2, null, null, null, null, null, null]);
});

test("taskFromRow keeps the DLC of an RTR row whose data came empty (stream)", () => {
  const t = taskFromRow({ ch: 1, id: 0x7e0, ext: false, rtr: true, data: "", dlc: 3 }, "t1");
  expect(t).toMatchObject({ rtr: true, data: "000000" });
  expect(taskFromRow({ ch: 1, id: 0x7e0, ext: false, rtr: true, data: "0102" }, "t2").data).toBe("0000");
});
