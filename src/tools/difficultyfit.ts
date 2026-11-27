/**
 * Hit a target star rating (Star Rating Rebirth, see analysis/difficulty.ts) by removing or
 * adding notes cleanly. Used after generation (built-in or AI) and as a stand-alone tool.
 *
 *   too hard -> remove the least important notes first: finer snaps before strong beats,
 *               chord extras before single notes, notes in the hardest sections and in jacks first
 *   too easy -> add notes where they are musical and clean: chord notes on beats/half beats,
 *               then notes in 1/2 or 1/4 gaps between existing notes, in the hardest sections
 *               first; never a jack, never inside an LN, never 3+ notes on one hand in fast rows
 * A bisection over "how many of the ranked changes to apply" finds the target.
 */
import { type Beatmap, type Note, cloneBeatmap, getKeys, isLN, makeNote, sortNotes } from '../core/beatmap';
import { redLineAt, snapTime } from '../core/timing';
import { rng } from '../core/rng';
import { handOf } from '../analysis/patterns';
import { starRating } from '../analysis/difficulty';

export interface FitOptions {
  /** allowed difference to the target (default 0.1 stars) */
  tolerance?: number;
  /** bisection steps (default 12) */
  maxIter?: number;
  seed?: number;
  /** when adding notes is not enough, also allow 1/2-beat chord jacks (never faster than 1/4 beat
   *  or 100 ms). Off by default: the result stays as clean as the source. */
  allowJacks?: boolean;
  /**
   * Contrast-aware adjustment: the song's loudness around time t (a z-score: 0 = the song's
   * average, + louder). Removals then start in quiet parts and additions in loud parts, so the map
   * keeps (or gains) the contrast between them instead of flattening its loudest sections.
   */
  loudness?: (t: number) => number;
  /** weight of `loudness` against the other priorities (default 0.3) */
  loudnessWeight?: number;
  /** weight of "the hardest sections first" when removing with loudness (default 1; 2 without) */
  peakWeight?: number;
}

/**
 * Weight of the song's loudness when the adjustment has it (scripts/bench/fit-bench.ts: adjust a
 * ranked difficulty to another ranked difficulty's stars and compare with the human one). Removing
 * notes on 19 high-star 7K pairs: density contour r vs the human map 0.43 -> 0.51, density follows
 * loudness 0.40 -> 0.55 (human 0.69), rhythm F1 0.831 -> 0.826. On 17 mid pairs: 0.02 -> 0.11,
 * -0.11 -> 0.16 (human 0.36), F1 0.444 -> 0.416. Adding notes: unchanged.
 */
export const LOUDNESS_WEIGHT = 0.3;

export interface FitResult {
  map: Beatmap;
  stars: number;
  startStars: number;
  added: number;
  removed: number;
  reached: boolean;
}

/** Official osu! SR (what Mapperatorinator's difficulty input means) estimated from the Rebirth rating.
 *  Fitted on 120 ranked maps (4K/7K, rice and LN): MAE 0.29 stars. */
export function rebirthToOfficial(rebirth: number, lnShare = 0): number {
  return Math.max(0.5, 0.8695 * rebirth + 0.2131 - 0.2388 * lnShare);
}
export function officialToRebirth(official: number, lnShare = 0): number {
  return Math.max(0, (official - 0.2131 + 0.2388 * lnShare) / 0.8695);
}

function snapRank(map: Beatmap, t: number): number {
  const r = redLineAt(map, t);
  if (!r) return 2;
  const beats = (t - r.time) / r.beatLength;
  if (Math.abs(beats - Math.round(beats)) * r.beatLength <= 2) return Math.round(beats) % 4 === 0 ? 0 : 1;
  for (const [d, rank] of [[2, 2], [4, 3], [3, 3], [6, 3.5], [8, 4], [12, 4], [16, 4.5]] as const) {
    if (Math.abs(snapTime(map, t, d) - t) <= 2) return rank;
  }
  return 5;
}

/** difficulty curve value (0..1, relative to the map's peak) at time t */
function peakAt(curve: Float32Array, step: number, start: number, max: number): (t: number) => number {
  return (t) => {
    const i = Math.round((t - start) / step);
    return max > 0 ? (curve[Math.max(0, Math.min(curve.length - 1, i))] ?? 0) / max : 0;
  };
}

/** Removal order. It is built greedily in rounds so that hands stay balanced: within each 8-beat
 *  window, notes of the hand that still has more notes are removed first. */
function removalOrder(map: Beatmap, rand: () => number, loud?: (t: number) => number, peakW = 2): Note[] {
  const K = getKeys(map);
  const base = baseRemovalScores(map, rand, loud, peakW);
  const beat = redLineAt(map, map.notes[0]?.time ?? 0)?.beatLength ?? 500;
  const win = (t: number) => Math.floor(t / (beat * 8));
  const left = new Map<number, number>(), right = new Map<number, number>();
  for (const { n } of base) {
    const h = handOf(n.column, K);
    if (h === 0) left.set(win(n.time), (left.get(win(n.time)) ?? 0) + 1);
    if (h === 1) right.set(win(n.time), (right.get(win(n.time)) ?? 0) + 1);
  }
  const order: Note[] = [];
  let pool = base;
  const rounds = 60;
  const per = Math.ceil(pool.length / rounds);
  while (pool.length) {
    const scored = pool.map((x) => {
      const w = win(x.n.time);
      const l = left.get(w) ?? 0, r = right.get(w) ?? 0;
      const h = handOf(x.n.column, K);
      const share = l + r ? (h === 0 ? l : h === 1 ? r : (l + r) / 2) / (l + r) : 0.5;
      return { ...x, s: x.score + (share - 0.5) * 16 };
    }).sort((a, b) => b.s - a.s);
    const take = scored.slice(0, per);
    for (const x of take) {
      order.push(x.n);
      const w = win(x.n.time), h = handOf(x.n.column, K);
      if (h === 0) left.set(w, (left.get(w) ?? 1) - 1);
      if (h === 1) right.set(w, (right.get(w) ?? 1) - 1);
    }
    const gone = new Set(take.map((x) => x.n));
    pool = pool.filter((x) => !gone.has(x.n));
  }
  return order;
}

function baseRemovalScores(map: Beatmap, rand: () => number, loud?: (t: number) => number, peakW = 2): { n: Note; score: number }[] {
  const sr = starRating(map);
  const max = Math.max(...sr.curve, 1e-9);
  const peak = peakAt(sr.curve, sr.step, sr.start, max);
  const notes = sortNotes([...map.notes]);
  const rowSize = new Map<number, number>();
  for (const n of notes) rowSize.set(n.time, (rowSize.get(n.time) ?? 0) + 1);
  const lastInCol = new Map<number, number>();
  const scored = notes.map((n) => {
    const beat = redLineAt(map, n.time)?.beatLength ?? 500;
    const prev = lastInCol.get(n.column);
    lastInCol.set(n.column, n.time);
    const jack = prev !== undefined && n.time - prev <= beat / 2 + 2 ? 1 : 0;
    const chord = (rowSize.get(n.time) ?? 1) > 1 ? 1.5 : 0;
    // without loudness: thin the hardest sections first (stars drop fastest there); with it, thin
    // the quiet parts first and keep the loud ones
    const where = (loud ? peakW : 2) * peak(n.time) - (loud ? loud(n.time) : 0);
    const score = snapRank(map, n.time) + chord + jack + where + rand() * 0.3;
    return { n, score };
  });
  return scored;
}

interface Candidate { t: number; col: number; score: number }

function additionCandidates(map: Beatmap, rand: () => number, loud?: (t: number) => number): Candidate[] {
  const K = getKeys(map);
  const sr = starRating(map);
  const max = Math.max(...sr.curve, 1e-9);
  const peakOf = peakAt(sr.curve, sr.step, sr.start, max);
  // where notes go first: the hardest sections, or with loudness the loudest parts
  const peak = loud ? (t: number) => Math.max(-1, Math.min(2, loud(t))) : peakOf;
  const notes = sortNotes([...map.notes]);
  const rows: { t: number; cols: number[] }[] = [];
  for (const n of notes) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(r.t - n.time) <= 1) r.cols.push(n.column); else rows.push({ t: n.time, cols: [n.column] });
  }
  const out: Candidate[] = [];
  const handLoad = (cols: number[], c: number) => cols.filter((x) => handOf(x, K) === handOf(c, K) && handOf(c, K) !== -1).length;
  // (i) chord notes on beats / half beats
  for (const r of rows) {
    const rank = snapRank(map, r.t);
    if (rank > 2 || r.cols.length >= Math.ceil(K / 2) + 1) continue;
    for (let c = 0; c < K; c++) {
      if (r.cols.includes(c)) continue;
      if (handLoad(r.cols, c) >= 2) continue;
      out.push({ t: r.t, col: c, score: 3 - rank + 2 * peak(r.t) + rand() * 0.3 });
    }
  }
  // (ii) notes in gaps of 1/2 or 1/4 between rows inside phrases (gap <= 1 beat)
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i], b = rows[i + 1];
    const beat = redLineAt(map, a.t)?.beatLength ?? 500;
    const gap = b.t - a.t;
    if (gap > beat + 2) continue;
    for (const div of [2, 4]) {
      const stepMs = beat / div;
      if (gap < 2 * stepMs - 2) continue;
      for (let t = a.t + stepMs; t < b.t - stepMs / 2; t += stepMs) {
        const tt = snapTime(map, t, div);
        if (tt <= a.t || tt >= b.t) continue;
        const free = [...Array(K).keys()].filter((c) => !a.cols.includes(c) && !b.cols.includes(c));
        if (!free.length) continue;
        const c = free[Math.floor(rand() * free.length)];
        out.push({ t: tt, col: c, score: (div === 2 ? 1.5 : 0.5) + 2 * peak(tt) + rand() * 0.3 });
      }
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/** Add candidates in order, skipping any that would be unclean given what is already there. */
function applyAdditions(map: Beatmap, cands: Candidate[], count: number, jackBeats = 0.5): { map: Beatmap; added: number } {
  const out = cloneBeatmap(map);
  const K = getKeys(out);
  const byCol: Note[][] = Array.from({ length: K }, () => []);
  for (const n of out.notes) byCol[n.column].push(n);
  for (const c of byCol) c.sort((a, b) => a.time - b.time);
  const rowAt = new Map<number, number[]>();
  for (const n of out.notes) rowAt.set(n.time, [...(rowAt.get(n.time) ?? []), n.column]);
  let added = 0;
  for (const cand of cands) {
    if (added >= count) break;
    const beat = redLineAt(out, cand.t)?.beatLength ?? 500;
    const col = byCol[cand.col];
    // neighbours in this column
    let lo = 0, hi = col.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (col[m].time < cand.t) lo = m + 1; else hi = m; }
    const prev = col[lo - 1];
    const next = col[lo];
    const prevEnd = prev ? (isLN(prev) ? prev.endTime! : prev.time) : -Infinity;
    const minGap = Math.max(beat * jackBeats, jackBeats < 0.5 ? 100 : 0) + 2;
    if (prev && cand.t - prevEnd <= minGap) continue; // jack or inside/after an LN too soon
    if (next && next.time - cand.t <= minGap) continue;
    const row = rowAt.get(cand.t) ?? [];
    if (row.includes(cand.col)) continue;
    const h = handOf(cand.col, K);
    if (h !== -1 && row.filter((x) => handOf(x, K) === h).length >= 2) continue;
    const n = makeNote(cand.t, cand.col);
    col.splice(lo, 0, n);
    rowAt.set(cand.t, [...row, cand.col]);
    out.notes.push(n);
    added++;
  }
  out.notes = sortNotes(out.notes);
  return { map: out, added };
}

export function fitDifficulty(map: Beatmap, target: number, opts: FitOptions = {}): FitResult {
  const tol = opts.tolerance ?? 0.1;
  const maxIter = opts.maxIter ?? 12;
  const rand = rng(opts.seed ?? 1);
  const start = starRating(map).stars;
  const base: FitResult = { map: cloneBeatmap(map), stars: start, startStars: start, added: 0, removed: 0, reached: Math.abs(start - target) <= tol };
  if (base.reached || !map.notes.length) return base;

  if (start > target) {
    const loud = opts.loudness ? ((w) => (t: number) => w * opts.loudness!(t))(opts.loudnessWeight ?? LOUDNESS_WEIGHT) : undefined;
    const order = removalOrder(map, rand, loud, opts.peakWeight ?? 1);
    const drop = (k: number) => {
      const gone = new Set(order.slice(0, k));
      const m = cloneBeatmap(map);
      m.notes = sortNotes(map.notes.filter((n) => !gone.has(n)).map((n) => ({ ...n })));
      return m;
    };
    let lo = 0, hi = Math.floor(map.notes.length * 0.95), best = base;
    for (let i = 0; i < maxIter && lo <= hi; i++) {
      const mid = (lo + hi) >> 1;
      const m = drop(mid);
      const s = starRating(m).stars;
      const cand: FitResult = { map: m, stars: s, startStars: start, added: 0, removed: mid, reached: Math.abs(s - target) <= tol };
      if (Math.abs(s - target) < Math.abs(best.stars - target)) best = cand;
      if (cand.reached) return cand;
      if (s > target) lo = mid + 1; else hi = mid - 1;
    }
    return best;
  }

  // clean additions first (no jack within 1/2 beat); if that cannot reach the target, allow
  // 1/2-beat chord jacks (never faster than 1/4 beat or 100 ms) as harder charts do
  const cands = additionCandidates(map, rand, opts.loudness ? ((w) => (t: number) => w * opts.loudness!(t))(opts.loudnessWeight ?? LOUDNESS_WEIGHT) : undefined);
  let best = base;
  for (const jackBeats of opts.allowJacks ? [0.5, 0.25] : [0.5]) {
    let lo = 0, hi = cands.length;
    let top = -Infinity;
    for (let i = 0; i < maxIter && lo <= hi; i++) {
      const mid = (lo + hi) >> 1;
      const { map: m, added } = applyAdditions(map, cands, mid, jackBeats);
      const s = starRating(m).stars;
      top = Math.max(top, s);
      const cand: FitResult = { map: m, stars: s, startStars: start, added, removed: 0, reached: Math.abs(s - target) <= tol };
      if (Math.abs(s - target) < Math.abs(best.stars - target)) best = cand;
      if (cand.reached) return cand;
      if (s < target) lo = mid + 1; else hi = mid - 1;
    }
    if (top >= target) break;
  }
  return best;
}
