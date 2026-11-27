/**
 * Set the difficulty BEFORE generating: give a target star rating (Star Rating Rebirth) and the
 * built-in generator searches its own settings until the chart lands there.
 *
 *   1. pick the preset tier that fits the target (easy .. expert)
 *   2. if the tier cannot reach the target even at its densest / sparsest, move one tier up / down
 *   3. bisect the density filter inside the tier
 *   4. polish with fitDifficulty (clean note removal / addition) to get within the tolerance
 */
import type { Beatmap } from '../core/beatmap';
import type { Analysis } from './analysis';
import { type AutoMapOptions, type Difficulty, generateFromAnalysis, songStyleProbs, loudnessForMap } from './generate';
import { STYLE_MODEL } from './stylemodel';
import { starRating } from '../analysis/difficulty';
import { fitDifficulty } from '../tools/difficultyfit';
import { chartQuality } from './quality';
import { detectOnsets } from './analysis';

const TIERS: Difficulty[] = ['easy', 'normal', 'hard', 'insane', 'expert'];

/** rough Rebirth star range of each preset at default density (4K-7K songs around 150-190 BPM) */
export function tierFor(stars: number): Difficulty {
  if (stars < 1.8) return 'easy';
  if (stars < 2.8) return 'normal';
  if (stars < 4.0) return 'hard';
  if (stars < 5.5) return 'insane';
  return 'expert';
}

export interface TargetResult {
  map: Beatmap;
  stars: number;
  target: number;
  reached: boolean;
  difficulty: Difficulty;
  density: number;
  intensity: number;
  /** generator runs used by the search */
  tries: number;
}

/** From this target up, auto style decides per song between speed (dense streams / jumpstream /
 *  handstream) and chordjack, the two families the hardest ranked maps split into: */
export const SPEED_FIRST_STARS = 6;
/** ... songs whose average chordjack probability (style model, at the target) is below this go
 *  speed-first. Chosen on training songs only (scripts/bench, every third song held out). */
export const CHORDJACK_CUTOFF = 0.39;

export function generateForStars(
  a: Analysis,
  opts: AutoMapOptions & { targetStars: number; tolerance?: number; fit?: boolean },
): TargetResult {
  const target = opts.targetStars;
  // (speedBias undefined = not decided yet; 0 = decided against speed)
  if (opts.style === 'auto' && opts.speedBias === undefined && !opts.jackBias && target >= SPEED_FIRST_STARS) {
    const probs = songStyleProbs(a, opts.keys, target, opts.bpm, opts.offset);
    if (probs[STYLE_MODEL.classes.indexOf('chordjack')] >= CHORDJACK_CUTOFF) return generateForStars(a, { ...opts, speedBias: 0 });
    const speedy = generateForStars(a, { ...opts, speedBias: 1 });
    if (speedy.reached) return speedy;
    const plain = generateForStars(a, { ...opts, speedBias: 0 });
    return Math.abs(speedy.stars - target) <= Math.abs(plain.stars - target) ? speedy : { ...plain, tries: plain.tries + speedy.tries };
  }
  const tol = opts.tolerance ?? 0.1;
  let tries = 0;
  const gen = (difficulty: Difficulty, density: number, intensity = 1) => {
    tries++;
    const map = generateFromAnalysis(a, { ...opts, difficulty, density, intensity, onProgress: undefined });
    return { map, stars: starRating(map).stars, difficulty, density, intensity };
  };

  let ti = TIERS.indexOf(opts.difficulty ?? tierFor(target));
  let hiRun = gen(TIERS[ti], 1);
  let loRun = gen(TIERS[ti], 0.05);
  // walk tiers until the target is inside [sparsest, densest] of one tier
  for (let guard = 0; guard < TIERS.length; guard++) {
    if (hiRun.stars < target && ti < TIERS.length - 1) { ti++; hiRun = gen(TIERS[ti], 1); loRun = gen(TIERS[ti], 0.05); continue; }
    if (loRun.stars > target && ti > 0) { ti--; hiRun = gen(TIERS[ti], 1); loRun = gen(TIERS[ti], 0.05); continue; }
    break;
  }
  const diff = TIERS[ti];
  let best = Math.abs(hiRun.stars - target) < Math.abs(loRun.stars - target) ? hiRun : loRun;

  let lo = 0.05, hi = 1;
  if (hiRun.stars >= target && loRun.stars <= target) {
    for (let i = 0; i < 9 && Math.abs(best.stars - target) > tol / 2; i++) {
      const mid = (lo + hi) / 2;
      const r = gen(diff, mid);
      if (Math.abs(r.stars - target) < Math.abs(best.stars - target)) best = r;
      if (r.stars < target) lo = mid; else hi = mid;
    }
  }

  // the densest expert chart is still too easy: raise intensity (more onsets, bigger chords, streams)
  // (speed mode goes further: up to 4x the detected onsets, as dense as the hardest ranked streams)
  const maxIntensity = opts.speedBias ? 3 : 2;
  if (diff === 'expert' && hiRun.stars < target - tol) {
    const top = gen(diff, 1, maxIntensity);
    if (Math.abs(top.stars - target) < Math.abs(best.stars - target)) best = top;
    if (top.stars > target) {
      let lo2 = 1, hi2 = maxIntensity;
      for (let i = 0; i < 8 && Math.abs(best.stars - target) > tol / 2; i++) {
        const mid = (lo2 + hi2) / 2;
        const r = gen(diff, 1, mid);
        if (Math.abs(r.stars - target) < Math.abs(best.stars - target)) best = r;
        if (r.stars < target) lo2 = mid; else hi2 = mid;
      }
    }
  }

  let { map, stars } = best;
  if (opts.fit !== false && Math.abs(stars - target) > tol) {
    const f = fitDifficulty(map, target, { tolerance: tol, seed: opts.seed, loudness: loudnessForMap(a, map) });
    if (Math.abs(f.stars - target) < Math.abs(stars - target)) { map = f.map; stars = f.stars; }
  }
  // auto style that cannot reach a high target cleanly: let loud sections become chordjack
  if (opts.style === 'auto' && !opts.jackBias && !opts.speedBias && stars < target - tol) {
    const again = generateForStars(a, { ...opts, jackBias: 1 });
    if (Math.abs(again.stars - target) < Math.abs(stars - target)) return { ...again, tries: again.tries + tries };
  }
  return { map, stars, target, reached: Math.abs(stars - target) <= tol, difficulty: best.difficulty, density: best.density, intensity: best.intensity, tries };
}

/**
 * Quick rules candidates kept by best-of-N: each seed places the same rhythm in other patterns.
 * On held-out songs (scripts/bench/qr-rerank.ts, 6 seeds, picked by chartQuality) the kept chart
 * had 6-14% less dirt for 6K and 7K (7K 6+ stars 151 -> 142 per 1000 notes) and half the star
 * error (7K 0.029 -> 0.015), at the same rhythm F1 and pattern mix.
 */
export const QR_CANDIDATES = 6;

/** generateForStars for N seeds (opts.seed, +1, ...), keeping the chart with the best quality score */
export function generateBestOf(
  a: Analysis,
  opts: AutoMapOptions & { targetStars: number; tolerance?: number; fit?: boolean },
  n = QR_CANDIDATES,
): TargetResult & { quality: number; candidates: number } {
  const onsets = detectOnsets(a, 0.6);
  const base = opts.seed ?? 7;
  let best: (TargetResult & { quality: number }) | null = null;
  for (let k = 0; k < Math.max(1, n); k++) {
    const r = generateForStars(a, { ...opts, seed: base + k * 7919 });
    const q = chartQuality(r.map, a, opts.targetStars, { onsets }).total;
    if (!best || q > best.quality) best = { ...r, quality: q };
  }
  return { ...best!, candidates: Math.max(1, n) };
}
