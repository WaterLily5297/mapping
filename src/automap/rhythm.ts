/**
 * Learned rhythm: for every tick of the beat grid, how likely is it that a mapper puts a note
 * there? Features come from the audio around the tick (flux, bands, loudness, a detected onset),
 * the tick's place in the measure (beat, 1/2, 1/4, 1/8, triplet), the tempo and the star target.
 * The generator keeps the most likely ticks (as many as the density asks for) instead of only the
 * loudest onsets. High targets get a finer grid (1/8 and 1/6 where the tempo allows), as the
 * hardest ranked maps use them.
 * Model: logistic regression trained by scripts/bench/train-rhythm-model.ts on ranked maps.
 */
import type { Beatmap } from '../core/beatmap';
import { redLineAt } from '../core/timing';
import type { Analysis, Onset } from './analysis';

export const RHYTHM_FEATURES = [
  'flux', 'low', 'mid', 'high', 'salience', 'loudness', 'onsetStrength', 'onset',
  'downbeat', 'beat', 'half', 'quarter', 'eighth', 'triplet', 'other',
  'stars', 'bpm', 'starsXhalf', 'starsXquarter', 'starsXeighth', 'starsXtriplet', 'stepMs', 'bias',
] as const;

export interface RhythmModel { w: number[]; mean: number[]; std: number[] }

export interface Tick { t: number; frame: number; beatIndex: number; beatFrac: number }

/** Grid divisors for a tempo and star target: 1/4 (1/2 or 1/1 when that would be under 60 ms);
 *  from 5.5 stars also 1/6 (if at least 50 ms) and 1/8 (if at least 40 ms); from 7.5 stars, as the
 *  hardest ranked maps do, 1/6 down to 38 ms and 1/8 bursts down to 28 ms (1/8 at 240 BPM). */
export function gridDivisors(beatLen: number, stars: number, base = 4): number[] {
  let d = base;
  while (d > 1 && beatLen / d < 60) d /= 2;
  const out = [d];
  if (stars >= 5.5) {
    const top = stars >= 7.5;
    if (beatLen / 6 >= (top ? 38 : 50)) out.push(6);
    if (beatLen / 8 >= (top ? 28 : 40) && (d >= 4 || top)) out.push(8);
  }
  return out;
}

/** grid ticks between from and to (union of the divisors), following every red line of the map */
export function gridTicksFor(map: Beatmap, divisors: number | number[], from: number, to: number): Tick[] {
  const divs = typeof divisors === 'number' ? [divisors] : divisors;
  const out: Tick[] = [];
  const reds = map.timingPoints.filter((p) => p.uninherited).sort((a, b) => a.time - b.time);
  reds.forEach((r, i) => {
    const end = Math.min(to, reds[i + 1]?.time ?? Infinity);
    // walk in 1/lcm steps and keep positions on any of the divisors
    const lcm = divs.reduce((a, b) => (a * b) / gcd(a, b), 1);
    const step = r.beatLength / lcm;
    let k = Math.ceil((Math.max(from, r.time) - r.time) / step - 1e-6);
    for (let t = r.time + k * step; t < end; k++, t = r.time + k * step) {
      if (!divs.some((d) => (k * d) % lcm === 0)) continue;
      const beatIndex = Math.floor(k / lcm + 1e-9);
      out.push({ t: Math.round(t), frame: 0, beatIndex, beatFrac: (k - beatIndex * lcm) / lcm });
    }
  });
  return out;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

export interface RhythmContext { a: Analysis; onsets: Onset[]; rmsMean: number; fluxMean: number }

export function rhythmContext(a: Analysis, onsets: Onset[]): RhythmContext {
  let r = 0, f = 0;
  for (let i = 0; i < a.rms.length; i++) { r += a.rms[i]; f += a.flux[i]; }
  return { a, onsets, rmsMean: r / Math.max(1, a.rms.length), fluxMean: f / Math.max(1, a.flux.length) };
}

/** position classes of a beat fraction */
export function positionOf(frac: number): 'beat' | 'half' | 'quarter' | 'eighth' | 'triplet' | 'other' {
  const on = (d: number) => Math.abs(frac * d - Math.round(frac * d)) < 1e-6;
  if (on(1)) return 'beat';
  if (on(2)) return 'half';
  if (on(4)) return 'quarter';
  if (on(8)) return 'eighth';
  if (on(3) || on(6) || on(12)) return 'triplet';
  return 'other';
}

/** Features of one tick (ticks must come in time order: `cursor` walks the onset list).
 *  `finest` is the largest grid divisor in use (for the stepMs feature). */
export function tickFeatures(ctx: RhythmContext, map: Beatmap, tk: Tick, stars: number, cursor: { i: number }, finest: number): number[] {
  const { a } = ctx;
  const f = Math.round(tk.t / 1000 / a.frameDur);
  tk.frame = f;
  const mx = (arr: Float32Array, r: number) => { let m = 0; for (let j = f - r; j <= f + r; j++) if (j >= 0 && j < arr.length && arr[j] > m) m = arr[j]; return m; };
  const flux = mx(a.flux, 2);
  let local = 0, n = 0;
  for (let j = f - 20; j <= f + 20; j++) if (j >= 0 && j < a.flux.length) { local += a.flux[j]; n++; }
  const salience = flux - local / Math.max(1, n);
  const loud = (a.rms[Math.max(0, Math.min(a.rms.length - 1, f))] ?? 0) / Math.max(1e-6, ctx.rmsMean) - 1;
  while (cursor.i < ctx.onsets.length && ctx.onsets[cursor.i].time < tk.t - 35) cursor.i++;
  let os = 0;
  for (let j = cursor.i; j < ctx.onsets.length && ctx.onsets[j].time <= tk.t + 35; j++) os = Math.max(os, ctx.onsets[j].strength);
  const beat = redLineAt(map, tk.t)?.beatLength ?? 500;
  const pos = positionOf(tk.beatFrac);
  const downbeat = pos === 'beat' && tk.beatIndex % 4 === 0 ? 1 : 0;
  const onBeat = pos === 'beat' && !downbeat ? 1 : 0;
  const is = (p: string) => (pos === p ? 1 : 0);
  const s = stars / 5;
  return [
    flux, mx(a.bands[0], 2), mx(a.bands[1], 2), mx(a.bands[2], 2), salience, loud, os, os > 0 ? 1 : 0,
    downbeat, onBeat, is('half'), is('quarter'), is('eighth'), is('triplet'), is('other'),
    s, 60000 / beat / 200 - 1, s * is('half'), s * is('quarter'), s * is('eighth'), s * is('triplet'), beat / finest / 100, 1,
  ];
}

export function rhythmScore(m: RhythmModel, x: number[]): number {
  let z = 0;
  for (let i = 0; i < x.length; i++) z += (m.w[i] ?? 0) * (m.std[i] > 0 ? (x[i] - m.mean[i]) / m.std[i] : x[i]);
  return 1 / (1 + Math.exp(-z));
}
