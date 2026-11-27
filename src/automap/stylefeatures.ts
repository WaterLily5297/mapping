/**
 * Per-measure audio features for choosing a pattern style (used by the learned style model).
 * Everything is relative to the song (loudness, density), plus tempo, key count and target stars.
 */
import type { Analysis, Onset } from './analysis';
import type { Style } from './patternize';

export const STYLE_CLASSES: Style[] = ['balanced', 'stream', 'jumpstream', 'chordjack', 'tech', 'ln'];

export const FEATURE_NAMES = [
  'onsetsPerBeat', 'strongPerBeat', 'onsetStrength', 'loudness', 'sustain', 'flux',
  'low', 'mid', 'high', 'centroid', 'bpm', 'stars', 'keys', 'starsXonsets', 'starsXlow', 'bias',
] as const;

export interface SongContext {
  a: Analysis;
  onsets: Onset[];
  rmsMean: number;
  fluxMean: number;
}

export function songContext(a: Analysis, onsets: Onset[]): SongContext {
  let r = 0, f = 0;
  for (let i = 0; i < a.rms.length; i++) { r += a.rms[i]; f += a.flux[i]; }
  return { a, onsets, rmsMean: r / Math.max(1, a.rms.length), fluxMean: f / Math.max(1, a.flux.length) };
}

/** features of the window [t0, t1) ms that spans `beats` beats */
export function measureFeatures(ctx: SongContext, t0: number, t1: number, beats: number, bpm: number, stars: number, keys: number): number[] {
  const { a } = ctx;
  const f0 = Math.max(0, Math.floor(t0 / 1000 / a.frameDur)), f1 = Math.min(a.rms.length, Math.ceil(t1 / 1000 / a.frameDur));
  const n = Math.max(1, f1 - f0);
  let rms = 0, rms2 = 0, flux = 0, lo = 0, mid = 0, hi = 0, cen = 0;
  for (let f = f0; f < f1; f++) {
    rms += a.rms[f]; rms2 += a.rms[f] * a.rms[f]; flux += a.flux[f];
    lo += a.bands[0][f]; mid += a.bands[1][f]; hi += a.bands[2][f]; cen += a.centroid[f];
  }
  rms /= n; rms2 /= n; flux /= n;
  const bandSum = lo + mid + hi || 1;
  const std = Math.sqrt(Math.max(0, rms2 - rms * rms));
  // onsets in the window (binary search on the sorted list)
  let i = lowerBound(ctx.onsets, t0), count = 0, strong = 0, str = 0;
  for (; i < ctx.onsets.length && ctx.onsets[i].time < t1; i++) {
    count++;
    str += ctx.onsets[i].strength;
    if (ctx.onsets[i].strength > 0.35) strong++;
  }
  const opb = count / beats;
  const s = stars / 5;
  return [
    opb / 2, strong / beats / 2, count ? str / count : 0, rms / Math.max(1e-6, ctx.rmsMean) - 1,
    rms > 0 ? 1 - std / rms : 0, flux / Math.max(1e-6, ctx.fluxMean) - 1,
    lo / bandSum, mid / bandSum, hi / bandSum, cen / n, bpm / 200 - 1, s, keys / 7 - 1, s * opb / 2, s * (lo / bandSum), 1,
  ];
}

function lowerBound(o: Onset[], t: number): number {
  let lo = 0, hi = o.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (o[m].time < t) lo = m + 1; else hi = m; }
  return lo;
}

export interface StyleModel {
  /** the styles the model chooses between (rice styles; LN stays the user's choice) */
  classes: Style[];
  /** weights[class][feature] */
  weights: number[][];
  mean: number[];
  std: number[];
}

export function predictStyle(model: StyleModel, x: number[]): number[] {
  const z = x.map((v, i) => (model.std[i] > 0 ? (v - model.mean[i]) / model.std[i] : v));
  const logits = model.weights.map((w) => w.reduce((s, wi, i) => s + wi * z[i], 0));
  const m = Math.max(...logits);
  const e = logits.map((l) => Math.exp(l - m));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}
