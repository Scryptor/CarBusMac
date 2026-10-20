import { expect, test } from "vitest";
import type { TracerRowJson } from "../src/core/types";
import { copyRows, TRACE_COPY_COLUMNS } from "../src/features/tracer/copyRows";

const row = (i: number, over: Partial<TracerRowJson> = {}): TracerRowJson => ({
  i,
  pos: i,
  t: 0,
  ch: 1,
  dir: "rx",
  id: 0x7e8,
  ext: false,
  rtr: false,
  dlc: 0,
  data: "",
  marker: null,
  enabled: true,
  bp: false,
  start: false,
  finish: false,
  before_ms: 0,
  after_ms: 0,
  comment: "",
  ...over,
});

const rows = [
  row(0, { t: 0.0125, dlc: 3, data: "0102ff" }),
  row(1, { t: 1.5, id: 0x18daf110, ext: true, dlc: 1, data: "0a", comment: "ответ" }),
];

test("copyRows honours hex/dec and header", () => {
  expect(copyRows(rows, TRACE_COPY_COLUMNS, { header: true, idHex: true, dataHex: true })).toBe(
    "№\tВремя\tCH\tID\tDLC\tДанные\tКомментарий\n" +
      "1\t0,012\t1\t7E8\t3\t01 02 FF\t\n" +
      "2\t1,500\t1\t18DAF110\t1\t0A\tответ\n",
  );
  expect(copyRows(rows, TRACE_COPY_COLUMNS, { header: false, idHex: false, dataHex: false })).toBe(
    "1\t0,012\t1\t2024\t3\t1 2 255\t\n" + "2\t1,500\t1\t417001744\t1\t10\tответ\n",
  );
});

test("copyRows keeps every cell on one line and falls back to the ID comment", () => {
  const r = [row(0, { comment: "a\tb\nc" }), row(1)];
  expect(copyRows(r, ["comment"], { header: false, idHex: true, dataHex: true, idComments: { "2024:0": "ЭБУ" } })).toBe(
    "a b c\nЭБУ\n",
  );
});
