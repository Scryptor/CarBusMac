/** Программный фильтр по диапазону ID (вкладка Range), применяется на клиенте. */

export interface RangeSpec {
  from?: number;
  to?: number;
  exclude?: boolean;
}

export function matchIdFilter(id: number, spec: RangeSpec): boolean {
  if (spec.from === undefined && spec.to === undefined) return true;
  const lo = spec.from ?? -Infinity;
  const hi = spec.to ?? Infinity;
  const inRange = id >= lo && id <= hi;
  return spec.exclude ? !inRange : inRange;
}
