// @vitest-environment happy-dom
import { effect } from "@preact/signals";
import { expect, test } from "vitest";
import { resetStore, store } from "../src/core/store";
import { applyTheme } from "../src/core/theme";

test("live preview is not undone by the app-wide theme effect", () => {
  resetStore();
  let runs = 0;
  const dispose = effect(() => {
    runs++;
    applyTheme(store.settings.value);
  });
  try {
    applyTheme({ ...store.settings.value, grid_font_size: 16 });
    expect(runs).toBe(1);
    expect(document.documentElement.style.getPropertyValue("--grid-size")).toBe("16px");
    expect(document.documentElement.style.getPropertyValue("--row-h")).toBe("27px");
  } finally {
    dispose();
  }
});
