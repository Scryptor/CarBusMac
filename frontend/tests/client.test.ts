import { expect, test, vi } from "vitest";

const seen: { cmd: Record<string, unknown>; timeout: number | undefined }[] = [];
vi.mock("../src/core/ws", () => ({
  WsClient: class {
    request(cmd: Record<string, unknown>, timeout?: number) {
      seen.push({ cmd, timeout });
      return Promise.resolve({});
    }
  },
}));
vi.stubGlobal("location", { protocol: "http:", host: "localhost:8000" });

const { cmd, LONG_TIMEOUT_MS } = await import("../src/core/client");

test("долгие команды ждут ответа дольше обычного", async () => {
  await cmd("capture_save", { name: "x" });
  await cmd("tx_send", { id: "t" });
  expect(seen[0]).toEqual({ cmd: { type: "capture_save", name: "x" }, timeout: LONG_TIMEOUT_MS });
  expect(seen[1].timeout).toBeUndefined();
});
