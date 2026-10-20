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
