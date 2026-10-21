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

/** ref горящей ячейки (у неё `data-st` — момент начала подсветки). Фаза «послесвечения»
 * задаётся один раз, когда элемент создан: отрицательная animation-delay на время, прошедшее
 * с начала подсветки (ячейка могла появиться позже — прокрутка, новое окно). Переписывать её
 * при перерисовках (25 раз в секунду) нельзя: к ходу уже идущей анимации прибавлялось бы
 * прошедшее время, и подсветка гасла бы вдвое быстрее «Сбросить после». Функция общая для
 * всех ячеек (стабильная ссылка — Preact зовёт её только при создании и удалении элемента)
 * и ничего не возвращает (вернувшееся Preact хранит как очистку ref). */
export function phaseRef(el: HTMLElement | null): void {
  if (!el || el.dataset.phased) return;
  el.dataset.phased = "1";
  const st = Number(el.dataset.st);
  if (Number.isFinite(st)) el.style.animationDelay = `-${Math.max(0, Math.round(performance.now() - st))}ms`;
}
