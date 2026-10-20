/** Подсветка изменившихся байтов («послесвечение»). На каждый байт хранится момент
 * начала подсветки (performance.now()); байт горит mark_hold_ms («Сбросить после»).
 * Режим редких данных подсвечивает только изменения байтов, которые до этого стояли
 * не меньше rare_period_ms (частые изменения не мешают видеть редкие). */
export interface HighlightSettings {
  mark_changed: boolean;
  mark_hold_ms: number;
  rare_mode: boolean;
  rare_period_ms: number;
}

export function applyChanges(
  starts: number[],
  changed: number,
  stable: (number | null)[],
  now: number,
  s: HighlightSettings,
): number[] {
  const n = Math.max(starts.length, stable.length, changed ? 32 - Math.clz32(changed) : 0);
  const out = starts.slice();
  while (out.length < n) out.push(-Infinity);
  if (!s.mark_changed) return out;
  for (let i = 0; i < n && i < 32; i++) {
    if (!(changed & (1 << i))) continue;
    if (s.rare_mode) {
      const st = stable[i];
      if (st == null || st < s.rare_period_ms) continue;
    }
    out[i] = now;
  }
  return out;
}

export function isLit(start: number, now: number, holdMs: number): boolean {
  return now - start < holdMs;
}
