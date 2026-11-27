/**
 * Quality score of a generated chart, from what is known at generation time: the song's analysis,
 * the chart and the star target (never a ranked map). Used to keep the best of several candidates.
 * Each part is 0..1 (higher is better); `total` is their weighted sum.
 */
import type { Beatmap } from '../core/beatmap';
import type { Analysis, Onset } from './analysis';
import { detectOnsets } from './analysis';
import { energyCurve } from './energy';
import { starRating } from '../analysis/difficulty';
import { dirt } from '../tools/cleanliness';

export interface QualityParts {
  /** closeness to the star target: 1 at the target, 0 at 1.5 stars away */
  stars: number;
  /** share of the chart's rows within 25 ms of a detected sound */
  onBeat: number;
  /** correlation of the chart's density per measure with the music-energy curve, mapped to 0..1 */
  energy: number;
  /** 1 - share of the louder half of measures that have no note */
  filled: number;
  /** cleanliness: 1 at no dirt, lower with fast jacks and hand overload */
  clean: number;
}
export interface Quality { parts: QualityParts; total: number }

/** weights of the parts (set from the seed comparison, scripts/bench/seed-rerank.ts) */
export const QUALITY_WEIGHTS: QualityParts = { stars: 1, onBeat: 1, energy: 1, filled: 1, clean: 1 };

const pearson = (x: number[], y: number[]) => {
  const n = x.length; if (n < 3) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
};

export function chartQuality(map: Beatmap, a: Analysis, targetStars: number, opts: { onsets?: Onset[]; t0?: number; t1?: number; weights?: QualityParts } = {}): Quality {
  const notes = map.notes.filter((n) => (opts.t0 === undefined || n.time >= opts.t0) && (opts.t1 === undefined || n.time < opts.t1));
  const w = opts.weights ?? QUALITY_WEIGHTS;
  if (!notes.length) return { parts: { stars: 0, onBeat: 0, energy: 0, filled: 0, clean: 0 }, total: 0 };
  const onsets = opts.onsets ?? detectOnsets(a, 0.6);
  const sub: Beatmap = { ...map, notes };
  const stars = Math.max(0, 1 - Math.abs(starRating(sub).stars - targetStars) / 1.5);
  // rows on detected sounds
  const rows = [...new Set(notes.map((n) => n.time))].sort((x, y) => x - y);
  const ot = onsets.map((o) => o.time);
  let hit = 0, j = 0;
  for (const r of rows) { while (j + 1 < ot.length && ot[j + 1] <= r) j++; if (Math.abs((ot[j] ?? -1e9) - r) <= 25 || Math.abs((ot[j + 1] ?? -1e9) - r) <= 25) hit++; }
  const onBeat = hit / rows.length;
  // density against the energy curve, and loud measures left empty
  const red = map.timingPoints.find((p) => p.uninherited && p.beatLength > 0);
  const bar = (red?.beatLength ?? 500) * 4;
  const t0 = opts.t0 ?? notes[0].time, t1 = opts.t1 ?? notes[notes.length - 1].time;
  const { starts, energy: e } = energyCurve(a, onsets, bar, red?.time ?? 0, t0, t1);
  const dens = starts.map((s) => notes.filter((n) => n.time >= s && n.time < s + bar).length);
  const energy = (pearson(dens, e) + 1) / 2;
  const loud = starts.map((_, i) => i).filter((i) => e[i] >= 0);
  const filled = loud.length ? 1 - loud.filter((i) => dens[i] === 0).length / loud.length : 1;
  const d = dirt(sub);
  const clean = Math.max(0, 1 - d.score / 400);
  const parts = { stars, onBeat, energy, filled, clean };
  const total = (Object.keys(parts) as (keyof QualityParts)[]).reduce((s, k) => s + parts[k] * w[k], 0);
  return { parts, total };
}
