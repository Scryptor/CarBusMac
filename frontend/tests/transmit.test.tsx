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

import { applyEvent, resetStore } from "../src/core/store";
import { TransmitDock, txSelected } from "../src/features/transmit/TransmitDock";
import { newTask } from "../src/features/transmit/txModel";

beforeEach(() => {
  resetStore();
  calls.length = 0;
  txSelected.value = null;
});
afterEach(() => cleanup());

test("Enter in editor sends tx_send for the selected task", async () => {
  applyEvent({ type: "tx_state", tasks: [{ ...newTask("t1"), can_id: 0x7e0, data: "023e00" }] });
  render(<TransmitDock />);
  fireEvent.mouseDown(await screen.findByText("7E0"));
  const id = screen.getByLabelText("ID") as HTMLInputElement;
  expect(id.value).toBe("7E0");
  fireEvent.keyDown(id, { key: "Enter" });
  await new Promise((r) => setTimeout(r, 0));
  expect(calls.some((c) => c.type === "tx_send" && c.args.id === "t1")).toBe(true);
});

test("editing a field upserts the task after validation", async () => {
  applyEvent({ type: "tx_state", tasks: [{ ...newTask("t1"), can_id: 0x100 }] });
  render(<TransmitDock />);
  fireEvent.mouseDown(await screen.findByText("100"));
  const id = screen.getByLabelText("ID");
  fireEvent.input(id, { target: { value: "800" } });
  await new Promise((r) => setTimeout(r, 400));
  expect(calls.some((c) => c.type === "tx_upsert")).toBe(false);
  expect(id.getAttribute("aria-invalid")).toBe("true");
  fireEvent.input(id, { target: { value: "321" } });
  await new Promise((r) => setTimeout(r, 400));
  const up = calls.find((c) => c.type === "tx_upsert");
  expect((up?.args.task as { can_id: number }).can_id).toBe(0x321);
});
