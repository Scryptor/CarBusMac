/** Битрейт CAN: пресеты и расчёт ручного тайминга (аналог диалога Manage bit rates). */

export interface CanTiming {
  prescaler: number;
  seg1: number;
  seg2: number;
  sjw: number;
}

export const PRESET_BITRATES = [
  10_000, 20_000, 33_333, 50_000, 83_333, 100_000, 125_000, 250_000, 500_000, 800_000, 1_000_000,
];

/** Подобрать тайминг (prescaler/seg1/seg2/sjw) под битрейт, частоту и точку выборки (50..90%).
 * Перебирает число квантов 8..25 с целым prescaler, выбирает ближайшую точку выборки. */
export function sampleToTiming(bitrate: number, clockHz: number, samplePct: number): CanTiming {
  if (samplePct < 50 || samplePct > 90) {
    throw new Error("sample point must be 50..90%");
  }
  const totalDiv = clockHz / bitrate;
  let best: CanTiming | null = null;
  let bestErr = Infinity;
  for (let ntq = 25; ntq >= 8; ntq--) {
    const presc = totalDiv / ntq;
    if (Math.abs(presc - Math.round(presc)) > 1e-9 || Math.round(presc) < 1) continue;
    const seg1 = Math.round((ntq * samplePct) / 100) - 1;
    const seg2 = ntq - 1 - seg1;
    if (seg1 < 1 || seg2 < 1) continue;
    const sp = ((1 + seg1) / ntq) * 100;
    const err = Math.abs(sp - samplePct);
    if (err < bestErr) {
      bestErr = err;
      best = { prescaler: Math.round(presc), seg1, seg2, sjw: Math.min(seg2, 4) };
    }
  }
  if (!best) throw new Error(`no integer bit timing for ${bitrate} bps @ ${clockHz} Hz`);
  return best;
}
