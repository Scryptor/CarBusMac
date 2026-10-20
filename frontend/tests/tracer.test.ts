import { test, expect } from "vitest";
import { playerControls } from "../src/lib/tracer";

test("step allowed only when stopped", () => {
  expect(playerControls({ playing: true }, "step")).toEqual({ playing: true });
  expect(playerControls({ playing: false }, "step").stepped).toBe(true);
});

test("play then stop toggles", () => {
  expect(playerControls({ playing: false }, "play").playing).toBe(true);
  expect(playerControls({ playing: true }, "stop").playing).toBe(false);
});
