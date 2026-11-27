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
  // context: the sounds around the tick (after bias, so a model trained before them gives them no weight)
  'osPrev', 'osNext', 'osShareOfBeat', 'onsetsNearby', 'loudVsBeats',
] as const;

/**
 * Logistic regression over standardised tick features, optionally with a small hidden layer added
 * to its log-odds (ReLU units over the same standardised features; trained as a residual on top of
 * the linear part, so without `mlp` the model is the plain linear one).
 */
export interface RhythmModel { w: number[]; mean: number[]; std: number[]; mlp?: { h: number; W1: number[]; b1: number[]; w2: number[]; b2: number } }

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
  const step = beat / finest;
  const pos = positionOf(tk.beatFrac);
  const downbeat = pos === 'beat' && tk.beatIndex % 4 === 0 ? 1 : 0;
  const onBeat = pos === 'beat' && !downbeat ? 1 : 0;
  const is = (p: string) => (pos === p ? 1 : 0);
  const s = stars / 5;
  return [
    flux, mx(a.bands[0], 2), mx(a.bands[1], 2), mx(a.bands[2], 2), salience, loud, os, os > 0 ? 1 : 0,
    downbeat, onBeat, is('half'), is('quarter'), is('eighth'), is('triplet'), is('other'),
    s, 60000 / beat / 200 - 1, s * is('half'), s * is('quarter'), s * is('eighth'), s * is('triplet'), beat / finest / 100, 1,
    // context
    strongestOnset(ctx, tk.t - step - 35, tk.t - step + 35), strongestOnset(ctx, tk.t + step - 35, tk.t + step + 35),
    os / Math.max(0.05, strongestOnset(ctx, tk.t - beat / 2, tk.t + beat / 2)),
    onsetCount(ctx, tk.t - beat, tk.t + beat) / 8,
    loudVs(a, f, Math.round(beat * 4 / 1000 / a.frameDur)),
  ];
}

/** first onset index at or after time t (onsets are in time order) */
function onsetIndex(ctx: RhythmContext, t: number): number {
  let lo = 0, hi = ctx.onsets.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ctx.onsets[mid].time < t) lo = mid + 1; else hi = mid; }
  return lo;
}
function strongestOnset(ctx: RhythmContext, t0: number, t1: number): number {
  let m = 0;
  for (let j = onsetIndex(ctx, t0); j < ctx.onsets.length && ctx.onsets[j].time <= t1; j++) m = Math.max(m, ctx.onsets[j].strength);
  return m;
}
function onsetCount(ctx: RhythmContext, t0: number, t1: number): number {
  return onsetIndex(ctx, t1 + 1e-6) - onsetIndex(ctx, t0);
}
/** loudness at frame f against the mean of +-r frames (0 = as loud as its surroundings) */
function loudVs(a: Analysis, f: number, r: number): number {
  let sum = 0, n = 0;
  for (let j = Math.max(0, f - r); j <= Math.min(a.rms.length - 1, f + r); j += 2) { sum += a.rms[j]; n++; }
  const here = a.rms[Math.max(0, Math.min(a.rms.length - 1, f))] ?? 0;
  return here / Math.max(1e-6, sum / Math.max(1, n)) - 1;
}

export function rhythmScore(m: RhythmModel, x: ArrayLike<number>): number {
  // a model trained on fewer features (before the context ones were added) uses only its own
  const n = Math.min(x.length, m.mean.length), zs = new Float64Array(n);
  let z = 0;
  for (let i = 0; i < n; i++) { zs[i] = m.std[i] > 0 ? (x[i] - m.mean[i]) / m.std[i] : x[i]; z += (m.w[i] ?? 0) * zs[i]; }
  const h = m.mlp;
  if (h) {
    z += h.b2;
    for (let j = 0; j < h.h; j++) {
      let a = h.b1[j];
      for (let i = 0; i < n; i++) a += h.W1[j * n + i] * zs[i];
      if (a > 0) z += h.w2[j] * a;
    }
  }
  return 1 / (1 + Math.exp(-z));
}
