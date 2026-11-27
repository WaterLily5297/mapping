import type { Beatmap } from '../core/beatmap';
import type { Analysis } from '../automap/analysis';
import { detectOnsets } from '../automap/analysis';
import { chartQuality } from '../automap/quality';
import type { AiOptions, AiJob } from './mapperatorinator';

/** seeds of the candidates are this far apart */
export const SEED_STEP = 7919;

/**
 * AI best of N: run the model N times with seeds spaced apart and keep the result with the best
 * quality score (the same score as Quick rules' best of N). On 6 held-out hard 4K songs, best of 3
 * moved the pattern mix closer to the ranked map (skill-mix distance 0.45 -> 0.34) with 10% fewer
 * fast jacks at the same rhythm F1; on hard 7K (best of 4) skill mix 0.163 -> 0.154 and fast
 * jacks 20 -> 13, rhythm F1 0.926 -> 0.918 (scripts/bench/seed-rerank.ts). Each candidate is a
 * full AI run, so it is opt-in. `start` is called once per candidate, in turn.
 */
export async function aiBestOf<P extends { map: Beatmap }>(n: number, opts: AiOptions, targetStars: number, o: {
  start: (opts: AiOptions) => Pick<AiJob, 'done'>; post: (osuText: string) => P;
  /** the song's analysis (undefined: no scoring possible, one candidate is made) */
  analyze: () => Analysis | undefined;
  log?: (line: string) => void; cancelled?: () => boolean;
}): Promise<{ best: P; scores: number[]; picked: number }> {
  const log = o.log ?? (() => {});
  const an = n > 1 ? o.analyze() : undefined;
  if (!an) return { best: o.post((await o.start(opts).done).osuText), scores: [], picked: 0 };
  const base = opts.seed ?? Math.floor(Math.random() * 1e6);
  const onsets = detectOnsets(an, 0.6);
  let best: P | undefined, picked = 0;
  const scores: number[] = [];
  for (let k = 0; k < n; k++) {
    if (o.cancelled?.()) throw new Error('cancelled');
    log(`candidate ${k + 1}/${n}`);
    const res = await o.start({ ...opts, seed: base + k * SEED_STEP }).done;
    const p = o.post(res.osuText);
    const q = chartQuality(p.map, an, targetStars, { onsets }).total;
    scores.push(q);
    log(`candidate ${k + 1}/${n}: quality ${q.toFixed(2)}`);
    if (!best || q > scores[picked]) { best = p; picked = k; }
  }
  return { best: best!, scores, picked };
}
