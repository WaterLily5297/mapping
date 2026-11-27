import type { Beatmap, TimingPoint } from './beatmap';

/** Uninherited (red) timing points only, sorted. */
export function redLines(map: Beatmap): TimingPoint[] {
  return map.timingPoints.filter((t) => t.uninherited).sort((a, b) => a.time - b.time);
}

/** The red line that governs `time` (the first one if `time` is before all of them). */
export function redLineAt(map: Beatmap, time: number): TimingPoint | undefined {
  const reds = redLines(map);
  if (!reds.length) return undefined;
  let cur = reds[0];
  for (const r of reds) {
    if (r.time <= time + 0.5) cur = r;
    else break;
  }
  return cur;
}

export function bpmAt(map: Beatmap, time: number): number {
  const r = redLineAt(map, time);
  return r ? 60000 / r.beatLength : 120;
}

/** Scroll-velocity multiplier at time (1.0 if no green line applies). */
export function svAt(map: Beatmap, time: number): number {
  let sv = 1;
  let redTime = -Infinity;
  for (const t of [...map.timingPoints].sort((a, b) => a.time - b.time)) {
    if (t.time > time) break;
    if (t.uninherited) {
      sv = 1;
      redTime = t.time;
    } else if (t.time >= redTime) {
      sv = t.beatLength < 0 ? -100 / t.beatLength : 1;
    }
  }
  return sv;
}

/**
 * Snap a time to the nearest 1/divisor beat of the governing red line.
 * Uses the same "beatLength / divisor" grid osu! uses, rounded to integer ms.
 */
export function snapTime(map: Beatmap, time: number, divisor: number): number {
  const r = redLineAt(map, time);
  if (!r) return Math.round(time);
  const step = r.beatLength / divisor;
  const k = Math.round((time - r.time) / step);
  let snapped = r.time + k * step;
  // do not snap across into the next red line's territory
  const next = redLines(map).find((x) => x.time > r.time);
  if (next && snapped >= next.time - 0.5) snapped = next.time;
  return Math.round(snapped);
}

/** Move to the previous/next grid tick (dir = -1 or +1). */
export function stepTime(map: Beatmap, time: number, divisor: number, dir: 1 | -1): number {
  const r = redLineAt(map, time);
  if (!r) return Math.round(time + dir * (500 / divisor));
  const step = r.beatLength / divisor;
  const k = Math.round((time - r.time) / step) + dir;
  return Math.round(r.time + k * step);
}

export interface GridTick {
  time: number;
  /** 0 = measure line, 1 = beat, else the smallest snap denominator that hits this tick (2,3,4,6,8,12,16) */
  kind: number;
}

/** All grid ticks in [from, to] for the given divisor. */
export function gridTicks(map: Beatmap, from: number, to: number, divisor: number): GridTick[] {
  const reds = redLines(map);
  if (!reds.length) return [];
  const ticks: GridTick[] = [];
  for (let i = 0; i < reds.length; i++) {
    const r = reds[i];
    const segEnd = i + 1 < reds.length ? reds[i + 1].time : Infinity;
    const segStart = i === 0 ? -Infinity : r.time;
    const a = Math.max(from, segStart);
    const b = Math.min(to, segEnd - 0.5);
    if (a > b) continue;
    const step = r.beatLength / divisor;
    let k = Math.ceil((a - r.time) / step);
    for (; ; k++) {
      const t = r.time + k * step;
      if (t > b) break;
      const beatIdx = k / divisor;
      let kind: number;
      if (Number.isInteger(beatIdx)) {
        kind = ((beatIdx % r.meter) + r.meter) % r.meter === 0 ? 0 : 1;
      } else {
        // smallest denominator d among common divisors such that k/divisor*d is an integer
        kind = divisor;
        for (const d of [2, 3, 4, 6, 8, 12, 16]) {
          if (Number.isInteger(Math.round(beatIdx * d * 1e6) / 1e6)) { kind = d; break; }
        }
      }
      ticks.push({ time: t, kind });
    }
  }
  return ticks;
}

/** Colour conventions from the osu! editor for snap divisors. */
export function tickColor(kind: number): string {
  switch (kind) {
    case 0: return '#ffffff';
    case 1: return '#c8c8c8';
    case 2: return '#ff5a5a';
    case 3: case 6: return '#b26bff';
    case 4: return '#4f8cff';
    case 8: return '#ffd24f';
    default: return '#777777';
  }
}
