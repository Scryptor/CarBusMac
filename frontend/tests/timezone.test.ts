import { expect, test, vi } from "vitest";

const calls: { type: string; args: Record<string, unknown> }[] = [];
vi.mock("../src/core/client", () => ({
  client: { on: () => () => {}, state: { value: "open" } },
  cmd: (type: string, args: Record<string, unknown> = {}) => {
    calls.push({ type, args });
    return Promise.resolve({});
  },
}));

import { reportTimeZone } from "../src/core/timezone";

test("the browser time zone is reported to the server", () => {
  reportTimeZone();
  expect(calls).toEqual([{ type: "client_tz", args: { tz: Intl.DateTimeFormat().resolvedOptions().timeZone } }]);
});
