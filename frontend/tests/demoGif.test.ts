import { describe, expect, it } from "vitest";
import { diffFrame, paletteSamples, resample } from "../scripts/demo-gif";

describe("resample: кадры скринкаста → равномерный таймлайн GIF", () => {
  it("на каждый тик берёт последний кадр не позже тика и склеивает повторы в задержку", () => {
    // кадры в секундах: 0, 50 мс, 120 мс, 310 мс, 500 мс; 10 к/с → тики каждые 100 мс
    const out = resample([0, 0.05, 0.12, 0.31, 0.5], 10);
    expect(out).toEqual([
      { frame: 0, delayMs: 100 },
      { frame: 1, delayMs: 100 }, // тик 100 мс: кадр 50 мс (120 мс ещё не было)
      { frame: 2, delayMs: 200 }, // тики 200 и 300 мс — один и тот же кадр 120 мс
      { frame: 3, delayMs: 100 },
      { frame: 4, delayMs: 100 },
    ]);
  });

  it("последний кадр держит дополнительную паузу holdMs", () => {
    expect(resample([0, 0.1], 10, 1500)).toEqual([
      { frame: 0, delayMs: 100 },
      { frame: 1, delayMs: 1600 },
    ]);
  });

  it("один кадр — один тик", () => {
    expect(resample([3.2], 10)).toEqual([{ frame: 0, delayMs: 100 }]);
    expect(resample([], 10)).toEqual([]);
  });
});

describe("diffFrame: неизменившиеся пиксели становятся прозрачными", () => {
  it("совпавшие индексы заменяет прозрачным, изменившиеся оставляет", () => {
    const prev = Uint8Array.from([1, 2, 3, 4]);
    const cur = Uint8Array.from([1, 9, 3, 7]);
    expect(Array.from(diffFrame(prev, cur, 255))).toEqual([255, 9, 255, 7]);
    expect(Array.from(cur)).toEqual([1, 9, 3, 7]); // исходный кадр не трогаем
  });
});

describe("paletteSamples: какие кадры идут в общую палитру", () => {
  it("берёт не больше max кадров, равномерно, всегда с первым и последним", () => {
    expect(paletteSamples(1, 8)).toEqual([0]);
    expect(paletteSamples(3, 8)).toEqual([0, 1, 2]);
    const s = paletteSamples(100, 8);
    expect(s).toHaveLength(8);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBe(99);
    expect([...s].sort((a, b) => a - b)).toEqual(s);
  });
});
