/**
 * The music's energy curve: how intense each measure feels, learned from where ranked maps get
 * denser or lighter (scripts/bench/train-energy-model.ts). Mappers follow more than loudness: new
 * sounds coming in, brightness, bass, noise and a build-up all matter. The curve is relative to
 * the song (0 = its average measure); Quick rules uses it for contrast, and candidate maps are
 * scored by how well they follow it.
 */
import type { Analysis, Onset } from './analysis';
import { ENERGY_MODEL, type EnergyModel } from './energymodel';

export const ENERGY_FEATURES = [
  'loudness', 'loudness peak', 'onsets per second', 'onset strength', 'flux', 'low band', 'mid band', 'high band',
  'brightness', 'noisiness', 'loudness vs previous 2 measures', 'onsets vs previous 2 measures', 'loudness vs next 2 measures',
  'position in song', 'bias',
];

const mean = (a: Float32Array | undefined, f0: number, f1: number) => {
  if (!a) return 0;
  let s = 0, n = 0;
  for (let i = Math.max(0, f0); i < Math.min(a.length, f1); i++) { s += a[i]; n++; }
  return n ? s / n : 0;
};
const peak = (a: Float32Array, f0: number, f1: number) => { let m = 0; for (let i = Math.max(0, f0); i < Math.min(a.length, f1); i++) if (a[i] > m) m = a[i]; return m; };

/** z-score a column within the song */
function zcol(v: number[]): number[] {
  const m = v.reduce((x, y) => x + y, 0) / Math.max(1, v.length);
  const sd = Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, v.length)) || 1;
  return v.map((x) => (x - m) / sd);
}

/**
 * Features of every measure (`barMs` long, starting at `offset`) between t0 and t1, z-scored within
 * the song so the curve describes the song's own ups and downs.
 */
export function energyFeatures(a: Analysis, onsets: Onset[], barMs: number, offset: number, t0: number, t1: number): { starts: number[]; x: number[][] } {
  const first = Math.floor((t0 - offset) / barMs), last = Math.floor((t1 - offset) / barMs);
  const starts: number[] = [];
  const raw: number[][] = [];
  const fr = (t: number) => Math.round(t / 1000 / a.frameDur);
  for (let k = first; k <= last; k++) {
    const s = offset + k * barMs, e = s + barMs, f0 = fr(s), f1 = fr(e);
    const os = onsets.filter((o) => o.time >= s && o.time < e);
    starts.push(s);
    raw.push([
      mean(a.rms, f0, f1), peak(a.rms, f0, f1), os.length / (barMs / 1000), os.reduce((x, o) => x + o.strength, 0) / Math.max(1, os.length),
      mean(a.flux, f0, f1), mean(a.bands[0], f0, f1), mean(a.bands[1], f0, f1), mean(a.bands[2], f0, f1),
      mean(a.centroid, f0, f1), mean(a.flatness, f0, f1),
    ]);
  }
  const cols = raw[0]?.length ?? 0;
  const z = Array.from({ length: cols }, (_, j) => zcol(raw.map((r) => r[j])));
  const x = raw.map((_, i) => {
    const prev = (j: number) => (z[j][i - 1] !== undefined ? (z[j][i - 1] + (z[j][i - 2] ?? z[j][i - 1])) / 2 : z[j][i]);
    const next = (j: number) => (z[j][i + 1] !== undefined ? (z[j][i + 1] + (z[j][i + 2] ?? z[j][i + 1])) / 2 : z[j][i]);
    return [...z.map((c) => c[i]), z[0][i] - prev(0), z[2][i] - prev(2), z[0][i] - next(0), raw.length > 1 ? i / (raw.length - 1) : 0, 1];
  });
  return { starts, x };
}

/** predicted relative intensity of every measure (z-score: 0 = the song's average measure) */
export function energyCurve(a: Analysis, onsets: Onset[], barMs: number, offset: number, t0: number, t1: number, model: EnergyModel | null = ENERGY_MODEL): { starts: number[]; energy: number[] } {
  const { starts, x } = energyFeatures(a, onsets, barMs, offset, t0, t1);
  if (!model) return { starts, energy: x.map((r) => r[0]) }; // loudness alone
  const raw = x.map((r) => r.reduce((s, v, j) => s + v * (model.w[j] ?? 0), 0));
  return { starts, energy: zcol(raw) };
}
