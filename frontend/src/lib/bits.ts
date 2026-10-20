/** Битовые помощники для монитора и карты бит. */

/** Байт → 8 булевых бит, старший первым (x80, x40, …, x01). */
export function byteToBits(b: number): boolean[] {
  const out: boolean[] = [];
  for (let pos = 0; pos < 8; pos++) out.push(((b >> (7 - pos)) & 1) === 1);
  return out;
}

/** Индексы байтов, выставленных в маске изменений (бит i → байт i). */
export function changedByteIndices(mask: number): number[] {
  const out: number[] = [];
  let i = 0;
  while (mask) {
    if (mask & 1) out.push(i);
    mask >>>= 1;
    i++;
  }
  return out;
}

/** Позиции бит (MSB-first, как в byteToBits), изменившиеся между prev и cur. */
export function diffBits(prev: number, cur: number): number[] {
  const x = (prev ^ cur) & 0xff;
  const out: number[] = [];
  for (let pos = 0; pos < 8; pos++) if ((x >> (7 - pos)) & 1) out.push(pos);
  return out;
}
