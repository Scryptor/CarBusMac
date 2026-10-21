/** Чистая часть записи демо-гифок (без браузера и файлов): пересэмплирование кадров
 * скринкаста в равномерный таймлайн, межкадровая прозрачность и выбор кадров для
 * общей палитры. Драйвер с Chrome и сценариями — record-demos.ts. */

export interface GifTick {
  /** индекс кадра скринкаста */
  frame: number;
  /** сколько держать кадр, мс */
  delayMs: number;
}

/** Кадры скринкаста приходят неравномерно (только когда страница перерисовалась).
 * На каждый тик с шагом 1/fps берётся последний кадр не позже тика; одинаковые
 * соседние тики сливаются в один кадр с большей задержкой; последний кадр держится
 * ещё holdMs, чтобы зацикленная гифка не перескакивала на начало мгновенно. */
export function resample(timestamps: number[], fps: number, holdMs = 0): GifTick[] {
  if (timestamps.length === 0) return [];
  const step = 1 / fps;
  const stepMs = Math.round(1000 / fps);
  const t0 = timestamps[0];
  const ticks = Math.floor((timestamps[timestamps.length - 1] - t0) / step + 1e-9) + 1;
  const out: GifTick[] = [];
  let frame = 0;
  for (let k = 0; k < ticks; k++) {
    const t = t0 + k * step;
    while (frame + 1 < timestamps.length && timestamps[frame + 1] <= t + 1e-9) frame++;
    const last = out[out.length - 1];
    if (last && last.frame === frame) last.delayMs += stepMs;
    else out.push({ frame, delayMs: stepMs });
  }
  out[out.length - 1].delayMs += holdMs;
  return out;
}

/** Пиксели, не изменившиеся с прошлого кадра, получают прозрачный индекс: при
 * «не удалять предыдущий кадр» GIF показывает старое значение, а длинные ряды одного
 * индекса LZW сжимает почти в ничто — размер растёт только с изменившейся областью. */
export function diffFrame(prev: Uint8Array, cur: Uint8Array, transparentIndex: number): Uint8Array {
  const out = new Uint8Array(cur.length);
  for (let i = 0; i < cur.length; i++) out[i] = cur[i] === prev[i] ? transparentIndex : cur[i];
  return out;
}

/** Индексы кадров для построения общей палитры: не больше max, равномерно по
 * таймлайну, обязательно первый и последний (тёмная тема в конце сценария должна
 * попасть в палитру так же, как светлая в начале). */
export function paletteSamples(count: number, max: number): number[] {
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  return Array.from({ length: max }, (_, k) => Math.round((k * (count - 1)) / (max - 1)));
}
