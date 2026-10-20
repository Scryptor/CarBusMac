/** Битрейт CAN: стандартные скорости прибора и расчёт своего тайминга (аналог
 * десктопного «Управление скоростями»). */
import type { Timing } from "../core/types";
import { t } from "../i18n/ru";

/** Номинальные скорости, которые прибор открывает по индексу (таблица carbus-lib). */
export const PRESET_BITRATES = [
  10_000, 20_000, 33_300, 50_000, 62_500, 83_300, 95_200, 100_000, 125_000, 250_000, 400_000, 500_000, 800_000,
  1_000_000,
];

export interface TimingLimits {
  presc: [number, number];
  seg1: [number, number];
  seg2: [number, number];
  sjw: [number, number];
}

/** Пределы номинального тайминга контроллера CH32. */
export const NOMINAL_LIMITS: TimingLimits = { presc: [1, 512], seg1: [1, 256], seg2: [1, 128], sjw: [1, 128] };

/** Минимум квантов на бит по ISO 11898-1; до 25 — предпочтительный диапазон. */
const MIN_TQ = 8;
const PREFERRED_MAX_TQ = 25;

const inRange = (v: number, [lo, hi]: [number, number]) => v >= lo && v <= hi;

/** Подобрать тайминг под скорость и точку выборки (50..90 %): сначала ближайшая
 * скорость, потом ближайшая точка выборки, потом больше квантов (до 25). SJW = min(Seg2, 4). */
export function bestTiming(
  bitrate: number,
  clockHz: number,
  samplePct: number,
  limits: TimingLimits = NOMINAL_LIMITS,
): Timing | null {
  if (!(samplePct >= 50 && samplePct <= 90) || !(bitrate > 0) || !(clockHz > 0)) return null;
  const maxTq = 1 + limits.seg1[1] + limits.seg2[1];
  let best: { t: Timing; rateErr: number; spErr: number; tq: number } | null = null;
  for (let presc = limits.presc[0]; presc <= limits.presc[1]; presc++) {
    const tq = Math.round(clockHz / (presc * bitrate));
    if (tq < MIN_TQ || tq > maxTq) continue;
    const seg1 = Math.min(Math.max(Math.round((tq * samplePct) / 100) - 1, limits.seg1[0]), limits.seg1[1]);
    const seg2 = tq - 1 - seg1;
    if (!inRange(seg2, limits.seg2)) continue;
    const rateErr = Math.abs(clockHz / (presc * tq) - bitrate) / bitrate;
    const spErr = Math.abs(((1 + seg1) / tq) * 100 - samplePct);
    if (best && !better(rateErr, spErr, tq, best)) continue;
    const sjw = Math.min(Math.max(Math.min(seg2, 4), limits.sjw[0]), limits.sjw[1]);
    best = { t: { prescaler: presc, seg1, seg2, sjw }, rateErr, spErr, tq };
  }
  return best ? best.t : null;
}

function better(rateErr: number, spErr: number, tq: number, cur: { rateErr: number; spErr: number; tq: number }): boolean {
  const eps = 1e-9;
  if (Math.abs(rateErr - cur.rateErr) > eps) return rateErr < cur.rateErr;
  if (Math.abs(spErr - cur.spErr) > eps) return spErr < cur.spErr;
  const pref = (n: number) => (n <= PREFERRED_MAX_TQ ? 0 : 1);
  if (pref(tq) !== pref(cur.tq)) return pref(tq) < pref(cur.tq);
  return pref(tq) === 0 ? tq > cur.tq : tq < cur.tq;
}

/** Что получится на шине с этим таймингом: скорость, точка выборки и отклонение
 * скорости от заданной (в процентах; без заданной — 0). */
export function timingInfo(
  t: Timing,
  clockHz: number,
  target?: number,
): { bitrate: number; samplePct: number; accuracyPct: number } {
  const tq = 1 + t.seg1 + t.seg2;
  const bitrate = clockHz / (t.prescaler * tq);
  const samplePct = ((1 + t.seg1) / tq) * 100;
  const accuracyPct = target ? ((bitrate - target) / target) * 100 : 0;
  return { bitrate, samplePct, accuracyPct };
}

/** Проверка тайминга, введённого руками: текст ошибки или null. */
export function timingError(tm: Timing, limits: TimingLimits = NOMINAL_LIMITS): string | null {
  const fields: [keyof Timing, [number, number], string][] = [
    ["prescaler", limits.presc, t.bitrate.prescaler],
    ["seg1", limits.seg1, t.bitrate.seg1],
    ["seg2", limits.seg2, t.bitrate.seg2],
    ["sjw", limits.sjw, t.bitrate.sjw],
  ];
  for (const [k, range, label] of fields) {
    if (!Number.isInteger(tm[k]) || !inRange(tm[k], range)) return t.err.range(label, range[0], range[1]);
  }
  if (tm.sjw > tm.seg2) return t.bitrate.sjwTooBig;
  return null;
}
