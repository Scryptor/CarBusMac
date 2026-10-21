/** Чистая математика виртуального грида: какие строки рисовать, куда прокрутить. */

/** Диапазон строк [first, last) для отрисовки с запасом overscan сверху и снизу. */
export function visibleRange(scrollTop: number, viewport: number, rowH: number, total: number, overscan = 6) {
  if (total <= 0) return { first: 0, last: 0 };
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, total * rowH - viewport));
  return {
    first: Math.max(0, Math.floor(top / rowH) - overscan),
    last: Math.min(total, Math.ceil((top + viewport) / rowH) + overscan),
  };
}

/** Минимальная прокрутка, при которой строка i видна целиком. */
export function scrollTopForRow(i: number, scrollTop: number, viewport: number, rowH: number): number {
  const top = i * rowH;
  const bottom = top + rowH;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewport) return bottom - viewport;
  return scrollTop;
}

/** Пользователь «внизу» (с допуском в одну строку) — значит, следуем за новыми строками. */
export function isAtBottom(scrollTop: number, viewport: number, scrollHeight: number, rowH: number): boolean {
  return scrollTop + viewport >= scrollHeight - rowH;
}

/** Предельная высота тела таблицы. Chrome не делает элемент выше 33 554 432 px — при
 * 22 px на строку дальше строки 1 525 201 таблицу было бы не прокрутить, а в буфере
 * потока и в трейсе миллионы строк. Тело ограничиваем с запасом, позицию прокрутки
 * пересчитываем с коэффициентом. */
export const MAX_BODY_PX = 15_000_000;

/** Геометрия прокрутки: total — высота всех строк («виртуальная»), body — высота тела в
 * DOM, k — сколько px таблицы приходится на 1 px прокрутки элемента (1 — без масштаба).
 * viewport — видимая высота строк (без липкой шапки). */
export function scrollGeom(rowCount: number, rowH: number, viewport: number, maxBody = MAX_BODY_PX) {
  const total = Math.max(0, rowCount * rowH);
  const body = Math.min(total, maxBody);
  const maxPhys = Math.max(0, body - viewport);
  const maxVirt = Math.max(0, total - viewport);
  const k = total > body && maxPhys > 0 ? maxVirt / maxPhys : 1;
  return { total, body, maxPhys, maxVirt, k };
}

export type ScrollGeom = ReturnType<typeof scrollGeom>;

/** Позиция в таблице по прокрутке элемента (пользователь тянет ползунок). */
export function physToVirt(phys: number, g: ScrollGeom): number {
  if (g.k === 1) return phys;
  if (phys >= g.maxPhys) return g.maxVirt;
  return Math.min(g.maxVirt, Math.max(0, phys * g.k));
}

/** Прокрутка элемента, соответствующая позиции в таблице. */
export function virtToPhys(virt: number, g: ScrollGeom): number {
  if (g.k === 1) return virt;
  return Math.min(g.maxPhys, Math.max(0, virt / g.k));
}

/** Верх строки i внутри тела. При масштабе строки рисуются относительно текущей
 * прокрутки элемента phys (тело короче таблицы); без масштаба phys = virt и это i·rowH. */
export function rowTop(i: number, rowH: number, phys: number, virt: number): number {
  return phys === virt ? i * rowH : phys + i * rowH - virt;
}
