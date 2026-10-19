import { test, expect } from "vitest";
import { parseEvent } from "../src/ws";

test("parseEvent accepts a typed event", () => {
  expect(parseEvent('{"type":"status","connected":true}').type).toBe("status");
});

test("parseEvent rejects malformed json", () => {
  expect(() => parseEvent("{bad")).toThrow();
});

test("parseEvent rejects event without type", () => {
  expect(() => parseEvent('{"connected":true}')).toThrow();
});
