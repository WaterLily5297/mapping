/**
 * Rule-based chart generator for any key count.
 *
 *   audio -> onsets (+strength, pitch centroid) -> snap to beat grid
 *         -> density filter -> chord sizes -> column assignment -> LNs
 *
 * It is deliberately deterministic for a given seed so results are reproducible,
 * and every stage is a small function you can replace (e.g. with an ML model).
 */
import { type Beatmap, type Note, type TimingPoint, createBeatmap, makeNote, sortNotes, getKeys } from '../core/beatmap';
import { snapTime, redLineAt } from '../core/timing';
import { rng } from '../core/rng';
import { type Style, type StyleDef, STYLES, placeColumns, type PlannedRow } from './patternize';
import { songContext, measureFeatures, predictStyle } from './stylefeatures';
import { STYLE_MODEL, styleModelFor } from './stylemodel';
import { gridTicksFor, gridDivisors, rhythmContext, tickFeatures, rhythmScore } from './rhythm';
import { RHYTHM_MODEL, RHYTHM_MODELS_BY_KEYS } from './rhythmmodel';
import { chordTarget, chordSizeAt } from './chordtargets';
import { lnConvert } from '../tools/lnconvert';
import { placeLongNotes } from './longnotes';
import { energyCurve } from './energy';
import { LN_MODEL } from './lnmodel';
import { type Analysis, type Onset, analyze, detectOnsets, estimateTempo, beatPhase, ONSET_LATENCY, LATENCY_FRAC, WIN, stereoWidth, STEREO_WIDTH_AUTO } from './analysis';

export type Difficulty = 'easy' | 'normal' | 'hard' | 'insane' | 'expert';
export type { Style } from './patternize';
/** a style, or 'auto': the learned model picks one per measure from the music and the target stars */
export type StyleChoice = Style | 'auto';
export { STYLES } from './patternize';

export interface AutoMapOptions {
  keys: number;
  difficulty?: Difficulty;
  /** pattern style: auto (default in the app), balanced, stream, jumpstream, chordjack, tech, ln */
  style?: StyleChoice;
  /** use this timing (all red lines, e.g. from an existing map) instead of detecting one BPM:
   *  songs with tempo changes are snapped to their real beat grid */
  timingPoints?: TimingPoint[];
  /** star target (lets auto style pick styles that fit it) */
  targetStars?: number;
  /** 0..1: auto style leans towards chordjack in loud sections (to reach high targets) */
  jackBias?: number;
  /** 0..1: for targets the clean styles cannot reach: auto style leans to jumpstream, and streams
   *  get more and bigger chords (jumpstream / handstream), as the hardest ranked maps do */
  speedBias?: number;
  /** where notes may go: 'learned' (default) scores every grid tick with the rhythm model trained
   *  on ranked maps; 'onsets' keeps only detected onsets, ranked by strength and beat position */
  rhythm?: 'learned' | 'onsets';
  /** 1/8 and 1/6 ticks for targets from 5.5 stars. Default: on for 5K and up, off for 1K-4K
   *  (on held-out 6+ star maps it brought 7K closer to ranked maps but not 4K) */
  fineGrid?: boolean;
  /** override BPM/offset instead of detecting them */
  bpm?: number;
  offset?: number;
  /** snap divisor (default depends on difficulty) */
  divisor?: number;
  /** 0..1 how many onsets survive the density filter (default from difficulty) */
  density?: number;
  /** 0..1 fraction of eligible sustained notes that become LNs */
  lnRatio?: number;
  /** max notes per chord (default from difficulty and key count) */
  maxChord?: number;
  /** 1..2: push past the preset (used to reach high star targets). Above 1 it detects more
   *  onsets, makes bigger chords and fills loud gaps with 1/4 streams. Default 1. */
  intensity?: number;
  /** minimum ms between two notes in the same column (jack limit) */
  minJackGap?: number;
  /** 0..1 how strongly the lane target (pitch or stereo position) decides the column */
  pitchFollow?: number;
  /**
   * Sound direction: where a note's lane leans. 'stereo' follows the stereo position of the sound
   * (left channel -> left lanes), relative to the surrounding phrase; 'pitch' follows pitch (low ->
   * left); 'auto' (default) uses stereo when the song has a clearly panned mix (stereoWidth at least
   * STEREO_WIDTH_AUTO) and pitch otherwise (mono or centred mixes). Stereo needs analyzeStereo().
   */
  direction?: 'auto' | 'stereo' | 'pitch';
  /**
   * Contrast: how strongly the song's loudness (over about one measure) moves notes from quiet to
   * loud parts, on top of the rhythm model's choice of ticks. 0 = the rhythm model alone; default
   * defaultContrast(stars). Ranked maps follow loudness more than onsets (scripts/bench/contour.ts).
   */
  contrast?: number;
  seed?: number;
  metadata?: { title?: string; artist?: string; creator?: string; version?: string; audioFilename?: string };
  onProgress?: (stage: string, p: number) => void;
}

interface Preset {
  divisor: number;
  density: number;
  chordFrac: number;
  minJackGapBeats: number;
  lnRatio: number;
  od: number;
  hp: number;
  sensitivity: number;
}

const PRESETS: Record<Difficulty, Preset> = {
  easy:   { divisor: 2, density: 0.35, chordFrac: 0.25, minJackGapBeats: 1,    lnRatio: 0.15, od: 7,   hp: 7,   sensitivity: 0.3 },
  normal: { divisor: 2, density: 0.55, chordFrac: 0.34, minJackGapBeats: 0.5,  lnRatio: 0.2,  od: 7.5, hp: 7.5, sensitivity: 0.45 },
  hard:   { divisor: 4, density: 0.7,  chordFrac: 0.45, minJackGapBeats: 0.5,  lnRatio: 0.25, od: 8,   hp: 8,   sensitivity: 0.6 },
  insane: { divisor: 4, density: 0.85, chordFrac: 0.55, minJackGapBeats: 0.25, lnRatio: 0.25, od: 8,   hp: 8,   sensitivity: 0.75 },
  expert: { divisor: 4, density: 1.0,  chordFrac: 0.7,  minJackGapBeats: 0.25, lnRatio: 0.3,  od: 8.5, hp: 8.5, sensitivity: 0.9 },
};

export interface GridOnset extends Onset {
  snapped: number;
  /** position inside the beat: 0 = on beat, 0.5 = half, ... */
  beatFrac: number;
  /** 0-based beat index from offset */
  beatIndex: number;
}

/** Snap onsets to the grid, merging ones that land on the same tick. */
export function snapOnsets(map: Beatmap, onsets: Onset[], divisor: number): GridOnset[] {
  const byTick = new Map<number, GridOnset>();
  for (const o of onsets) {
    const s = snapTime(map, o.time, divisor);
    const r = redLineAt(map, s)!;
    const beats = (s - r.time) / r.beatLength;
    const beatIndex = Math.round(beats * divisor) / divisor;
    const g: GridOnset = {
      ...o, snapped: s, beatIndex: Math.floor(beatIndex + 1e-6),
      beatFrac: Math.round((beatIndex - Math.floor(beatIndex + 1e-6)) * divisor) / divisor,
    };
    const prev = byTick.get(s);
    if (!prev || prev.strength < g.strength) byTick.set(s, prev ? { ...g, strength: Math.max(g.strength, prev.strength) } : g);
  }
  return [...byTick.values()].sort((a, b) => a.snapped - b.snapped);
}

/** Metrical weight: downbeats > beats > half > quarter > other. */
function metricWeight(g: GridOnset): number {
  if (g.beatFrac === 0) return g.beatIndex % 4 === 0 ? 1 : 0.8;
  if (g.beatFrac === 0.5) return 0.6;
  if (g.beatFrac === 0.25 || g.beatFrac === 0.75) return 0.4;
  return 0.3;
}

/** Keep the most important onsets: combined score = strength * metric weight. */
export function densityFilter(onsets: GridOnset[], density: number): GridOnset[] {
  if (density >= 1) return onsets;
  const scored = onsets.map((o) => ({ o, s: o.strength * (0.5 + metricWeight(o)) }));
  const sorted = [...scored].sort((a, b) => b.s - a.s);
  const keep = Math.max(1, Math.round(onsets.length * Math.max(0.02, density)));
  const thr = sorted[Math.min(sorted.length - 1, keep - 1)].s;
  return scored.filter((x) => x.s >= thr).map((x) => x.o);
}

/** Generate a beatmap from a pre-computed analysis. */
export function generateFromAnalysis(a: Analysis, opts: AutoMapOptions): Beatmap {
  const keys = opts.keys;
  if (!(keys >= 1 && keys <= 18)) throw new Error('keys must be 1..18');
  const diff = opts.difficulty ?? 'hard';
  const P = PRESETS[diff];
  const rand = rng(opts.seed ?? 12345);
  const progress = opts.onProgress ?? (() => {});

  progress('tempo', 0);
  const reds = (opts.timingPoints ?? []).filter((p) => p.uninherited && p.beatLength > 0).sort((x, y) => x.time - y.time);
  const tempo = reds.length ? { bpm: 60000 / reds[0].beatLength, offset: reds[0].time, confidence: 1 }
    : opts.bpm ? { bpm: opts.bpm, offset: opts.offset ?? 0, confidence: 1 } : estimateTempo(a);
  if (!reds.length && opts.bpm && opts.offset === undefined) {
    tempo.offset = estimateTempoOffsetOnly(a, opts.bpm);
  }
  progress('tempo', 1);

  const beatLen = 60000 / tempo.bpm;
  // put the red line on the first beat at/after 0 ms
  let offset = reds.length ? reds[0].time : tempo.offset % beatLen;
  if (offset < 0) offset += beatLen;

  const map = createBeatmap({
    keys,
    bpm: tempo.bpm,
    offset,
    od: P.od,
    hp: P.hp,
    title: opts.metadata?.title,
    artist: opts.metadata?.artist,
    creator: opts.metadata?.creator ?? 'maniamap auto',
    version: opts.metadata?.version ?? `${keys}K ${diff[0].toUpperCase()}${diff.slice(1)} (auto)`,
    audioFilename: opts.metadata?.audioFilename,
  });

  if (reds.length) map.timingPoints = reds.map((p) => ({ ...p }));

  // tempo-aware grid: at very high BPM a 1/4 grid is finer than anything mappers use (284 BPM:
  // 53 ms); keep the grid step at 60 ms or more unless a divisor is asked for
  let divisor = opts.divisor ?? P.divisor;
  if (opts.divisor === undefined) while (divisor > 1 && beatLen / divisor < 60) divisor /= 2;
  const auto = opts.style === 'auto';
  const style = STYLES[(auto || !opts.style ? 'balanced' : opts.style) as Style];
  const measureStyles = auto
    ? autoStyles(a, offset, beatLen, keys, opts.targetStars ?? TIER_STARS[diff], opts.jackBias ?? 0, a.rms.length * a.frameDur * 1000, opts.speedBias ?? 0)
    : null;
  const styleAt = (t: number): StyleDef => {
    if (!measureStyles) return style;
    const m = Math.floor((t - offset) / (beatLen * 4) + 1e-6);
    return measureStyles[Math.max(0, Math.min(measureStyles.length - 1, m))] ?? style;
  };
  const extra = Math.max(0, Math.min(1, (opts.intensity ?? 1) - 1));
  // speed mode can go past intensity 2: more rows (not bigger chords), up to 4x the onsets
  const rowExtra = Math.max(0, Math.min(opts.speedBias ? 2 : 1, (opts.intensity ?? 1) - 1));
  const onsets = detectOnsets(a, Math.min(1, P.sensitivity + 0.15 * extra));
  const snapped = snapOnsets(map, onsets, divisor);
  let grid = opts.rhythm === 'onsets'
    ? densityFilter(snapped, opts.density ?? P.density)
    // above the densest preset (intensity > 1) the rhythm model adds its next most likely ticks
    : learnedRhythm(a, map, opts.divisor ? [divisor] : gridDivisors(beatLen, (opts.fineGrid ?? (keys >= 5 || (opts.speedBias ?? 0) > 0)) ? opts.targetStars ?? TIER_STARS[diff] : 0, divisor), onsets,
      opts.targetStars ?? TIER_STARS[diff], Math.round(snapped.length * Math.min(1, opts.density ?? P.density) * (1 + 1.5 * rowExtra)),
      opts.contrast ?? defaultContrast(opts.targetStars ?? TIER_STARS[diff]), beatLen * 4);
  // streams: from the intensity search, plus the style's own taste for them (not on the easiest tiers)
  // (auto style follows the music's own rhythm: no extra fill beyond what the star search asks for)
  const fillAt = (t: number) => Math.min(1, (opts.rhythm === 'onsets' ? extra : 0) + (divisor >= 4 && !auto ? styleAt(t).fill : 0));
  const learned = opts.rhythm !== 'onsets';
  if ((extra > 0 && !learned) || (divisor >= 4 && (measureStyles ?? [style]).some((st) => st.fill > 0))) grid = streamFill(map, a, grid, beatLen, Math.max(divisor, 4), fillAt, rand);

  // ---- chord sizes
  const maxChordFor = (st: StyleDef) => Math.max(1, Math.min(keys, opts.maxChord ?? Math.max(1, Math.round(keys * Math.min(0.85, (P.chordFrac + 0.25 * extra) * Math.max(1, st.chordScale))))));
  const strengths = grid.map((g) => g.strength * (0.6 + 0.4 * metricWeight(g))).sort((x, y) => x - y);
  const pct = (v: number) => {
    let lo = 0, hi = strengths.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (strengths[m] < v) lo = m + 1; else hi = m; }
    return strengths.length ? lo / strengths.length : 0;
  };

  // ---- chord sizes per row (the rhythm plan)
  // auto style in 7K sizes chords through the ranked maps' chord-size distribution at these stars:
  // on held-out songs chord-size distance 0.244 -> 0.155 at 6+ stars (54 songs better, 6 worse),
  // with rhythm F1 and pattern mix a little better and less dirt; 4K and 6K were not better.
  const chordDist = auto && CHORD_TARGETS_ON && CHORD_TARGET_KEYS.includes(keys) ? chordTarget(keys, opts.targetStars ?? TIER_STARS[diff]) : null;
  const plan: PlannedRow[] = [];
  let prevTime = -Infinity;
  for (const g of grid) {
    const t = g.snapped;
    const style = styleAt(t);
    const maxChord = maxChordFor(style);
    const speed = opts.speedBias ?? 0;
    // in speed mode intensity buys rows, not chords: the hardest ranked streams are ~80% single notes
    const cx = speed > 0 ? extra * 0.25 : extra;
    const jumpChance = Math.max(style.fastChords, cx);
    const p = pct(g.strength * (0.6 + 0.4 * metricWeight(g)));
    let chordSize = 1;
    if (maxChord > 1 && chordDist) {
      chordSize = chordSizeAt(chordDist, p);
      if (style.chordScale > 1 && chordSize > 1 && rand() < style.chordScale - 1) chordSize++;
      chordSize = Math.min(maxChord, chordSize);
    } else if (maxChord > 1) {
      // top percentiles get bigger chords; downbeats get a bonus
      chordSize = 1 + Math.floor(Math.pow(p, 2.2 - 1.2 * cx) * maxChord * (g.beatFrac === 0 ? 1 : 0.6) * Math.min(1, style.chordScale));
      if (style.chordScale > 1 && chordSize > 1 && rand() < style.chordScale - 1) chordSize++;
      chordSize = Math.min(maxChord, chordSize);
    }
    const dt = t - prevTime;
    // fast streams: shrink chords when notes are very close together ...
    if (dt < beatLen / 3 && chordSize > 1 && rand() > Math.max(cx * 0.8, jumpChance)) chordSize = Math.max(1, Math.floor(chordSize / 2));
    // ... but jumpstream-style chords on beats and half beats
    if (dt < beatLen / 3 && chordSize === 1 && maxChord > 1 && (g.beatFrac === 0 || g.beatFrac === 0.5) && rand() < jumpChance) {
      chordSize = Math.min(maxChord, 2 + (g.beatFrac === 0 && rand() < jumpChance * 0.5 ? 1 : 0));
    }
    if (style.minChord && keys >= 4 && chordSize < style.minChord && rand() < 0.85) chordSize = Math.min(maxChord, Math.max(style.minChord, chordSize));
    // hands in streams: mostly jumps, rarely hands/quads (unless the style is about chords)
    if (dt < beatLen / 3 && style.chordScale <= 1.1 && chordSize > Math.max(2, Math.floor(keys / 2)) && rand() < 0.85 - 0.5 * speed) chordSize = Math.max(2, Math.floor(keys / 2));
    // speed escalation: hands (3-note chords in 4K) on strong stream rows
    if (speed > 0 && dt < beatLen / 3 && chordSize === 2 && maxChord >= 3 && g.beatFrac === 0 && rand() < speed * 0.15) chordSize = 3;
    plan.push({ t, size: chordSize, centroid: g.centroid, beatFrac: g.beatFrac, beatIndex: g.beatIndex, style: measureStyles ? style : undefined });
    prevTime = t;
  }

  // ---- sound direction: the lane target of each row
  const dir = resolveDirection(a, opts.direction);
  if (dir === 'stereo') {
    const target = relativePan(a, plan.map((r) => r.t), beatLen * 8);
    plan.forEach((r, i) => { r.centroid = target[i]; });
  }

  // ---- column assignment: the pattern engine
  const jackLimit = opts.minJackGap ?? ((opts.speedBias ?? 0) > 0 && (opts.targetStars ?? 0) >= (keys <= 5 ? MINIJACK_STARS_LOW_KEYS : 7.5)
    ? Math.max(beatLen / 4 - 3, 60)
    : Math.max(beatLen * P.minJackGapBeats - 3, beatLen / 2 - 3, beatLen / 4 + 3, 91));
  const placed = placeColumns(plan, {
    keys, beatLen, style, rand, pitchFollow: opts.pitchFollow ?? (dir === 'stereo' ? 0.8 : 0.5),
    // top-end speed (7.5+ stars): 1/4-beat minijacks, as in the hardest ranked streams; without them
    // dense 1/8 runs in 4K have no free column. Everything else: no jack under 1/2 beat.
    minJackGap: jackLimit,
    lean: dir === 'stereo' ? 1 : 0,
  });
  // the pattern engine keeps the hands balanced, which overrides the stereo lean; mirror whole
  // measures (pattern shapes stay intact) so the hand on the sound's side plays it
  if (dir === 'stereo') mirrorToDirection(plan, placed, keys, beatLen * 4, offset, jackLimit);
  const notes: Note[] = [];
  plan.forEach((r, i) => { for (const c of placed[i]) notes.push(makeNote(r.t, c)); });

  // ---- long notes: notes followed by sustained loudness and enough room
  const lnRatio = opts.lnRatio ?? P.lnRatio;
  // long notes: the learned model (trained on ranked LN maps) when present, the loudness rule otherwise
  if (lnRatio > 0 && !style.ln) {
    // 6K: fewer but longer holds at the same setting (ranked 6K rice maps hold few notes, for longer).
    // Held-out 6K: rhythm F1 0.765 -> 0.779 (20 songs better, 6 worse) at the same pattern mix
    // (14 better, 11 worse); in 4K and 7K the learned placement as it is matched the ranked maps best.
    if (LN_MODEL) { map.notes = sortNotes(notes); if (keys === 6) placeLongNotes(map, a, lnRatio * 0.4, undefined, 1); else placeLongNotes(map, a, lnRatio); }
    else addLongNotes(map, notes, a, beatLen, divisor, lnRatio, rand);
  }

  map.notes = sortNotes(notes);
  if (style.ln) map.notes = lnConvert(map, { preset: style.ln, seed: opts.seed ?? 12345 }).notes;
  progress('done', 1);
  return map;
}

/** Fill gaps between onsets (up to one beat) with grid notes where the music is loud, with
 *  probability `amount` per gap: turns sparse rhythm into streams for high difficulty targets. */
/** The `count` grid ticks a mapper would most likely use (rhythm model), in time order. */
/**
 * Mirror each measure whose notes lean to the other side than its sounds (lane targets in
 * row.centroid), unless that would create a jack faster than `jackLimit` at its edges. Mirroring
 * keeps every pattern shape (and its hand split) and only moves it to the other side.
 */
export function mirrorToDirection(rows: PlannedRow[], cols: number[][], keys: number, barMs: number, offset: number, jackLimit: number): number {
  const bar = (t: number) => Math.floor((t - offset) / barMs + 1e-6);
  const groups = new Map<number, number[]>();
  rows.forEach((r, i) => { const b = bar(r.t); const g = groups.get(b) ?? []; g.push(i); groups.set(b, g); });
  const lastHit = (c: number, before: number, from: number) => { for (let i = from; i >= 0; i--) if (rows[i].t < before && cols[i].includes(c)) return rows[i].t; return -Infinity; };
  const nextHit = (c: number, after: number, from: number) => { for (let i = from; i < rows.length; i++) if (rows[i].t > after && cols[i].includes(c)) return rows[i].t; return Infinity; };
  let mirrored = 0;
  for (const idx of [...groups.keys()].sort((x, y) => x - y).map((b) => groups.get(b)!)) {
    const tgt = idx.reduce((s, i) => s + rows[i].centroid, 0) / idx.length;
    let lane = 0, n = 0;
    for (const i of idx) for (const c of cols[i]) { lane += c / Math.max(1, keys - 1); n++; }
    if (!n) continue;
    lane /= n;
    if (Math.abs(tgt - 0.5) < 0.1 || (tgt - 0.5) * (lane - 0.5) >= 0 || Math.abs(lane - 0.5) < 0.02) continue;
    const flip = idx.map((i) => cols[i].map((c) => keys - 1 - c));
    // edges: the first notes of each new column against the previous measure, the last against the next
    const first = idx[0], last = idx[idx.length - 1];
    let ok = true;
    for (let k = 0; k < idx.length && ok; k++) {
      const i = idx[k];
      for (const c of flip[k]) {
        const earlierInBar = idx.slice(0, k).some((j, kk) => flip[kk].includes(c));
        const laterInBar = idx.slice(k + 1).some((j, kk) => flip[k + 1 + kk].includes(c));
        if (!earlierInBar && rows[i].t - lastHit(c, rows[first].t, first - 1) < jackLimit - 0.5) ok = false;
        if (!laterInBar && nextHit(c, rows[last].t, last + 1) - rows[i].t < jackLimit - 0.5) ok = false;
      }
    }
    if (!ok) continue;
    idx.forEach((i, k) => { cols[i] = flip[k]; });
    mirrored++;
  }
  return mirrored;
}

/** which lane target generation uses for this song */
export function resolveDirection(a: Analysis, d: AutoMapOptions['direction']): 'stereo' | 'pitch' {
  if (!a.pan || d === 'pitch') return 'pitch';
  if (d === 'stereo') return 'stereo';
  return stereoWidth(a) >= STEREO_WIDTH_AUTO ? 'stereo' : 'pitch';
}

/**
 * Lane target 0 (left) .. 1 (right) from the stereo position of each row, relative to the rows
 * around it (within `windowMs`): a finite set of lanes cannot hold the exact stereo field, so
 * sounds near the centre are still placed left or right of the others in the same phrase.
 */
export function relativePan(a: Analysis, times: number[], windowMs: number): number[] {
  const at = (t: number) => {
    const f = Math.round(t / 1000 / a.frameDur - (LATENCY_FRAC * WIN) / a.hop);
    // strongest-onset pan in +-2 frames
    let best = 0, w = -1;
    for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < a.flux.length && a.flux[k] > w) { w = a.flux[k]; best = a.pan![k]; }
    return best;
  };
  const p = times.map(at);
  return times.map((t, i) => {
    let s = 0, q = 0, n = 0;
    for (let j = i; j >= 0 && t - times[j] <= windowMs / 2; j--) { s += p[j]; q += p[j] * p[j]; n++; }
    for (let j = i + 1; j < times.length && times[j] - t <= windowMs / 2; j++) { s += p[j]; q += p[j] * p[j]; n++; }
    const m = s / n, sd = Math.sqrt(Math.max(0, q / n - m * m));
    // two standard deviations span the lanes; a near-constant phrase stays centred
    return Math.max(0, Math.min(1, 0.5 + (p[i] - m) / (4 * Math.max(sd, 0.02))));
  });
}

/**
 * Default `contrast` for a star target: 0 up to 3 stars, rising to 1.5 at 6 stars and above.
 * 1.5 was tuned on training 7K songs (scripts/bench/contour.ts: it matches the ranked maps'
 * spread between quiet and loud measures). On held-out 6+ star 7K songs it took the density
 * contour's correlation with the ranked maps 0.40 -> 0.59, the contrast 0.56x -> 0.95x of the
 * ranked maps', skill-mix distance 0.25 -> 0.20 and star error 0.15 -> 0.11 (rhythm F1 0.778 ->
 * 0.767). Around 4 stars the charts already had the ranked contrast and 1.5 overshot it (1.45x)
 * and cost rhythm F1 (0.815 -> 0.785), hence the ramp.
 */
export function defaultContrast(stars: number): number {
  return 1.5 * Math.max(0, Math.min(1, (stars - 3) / 3));
}

/**
 * Loudness over a window of `windowMs` around each frame, as a z-score within the song
 * (0 = the song's average, +1 = one standard deviation louder).
 */
export function loudnessEnvelope(a: Analysis, windowMs: number): Float32Array {
  const n = a.rms.length, half = Math.max(1, Math.round(windowMs / 2 / 1000 / a.frameDur));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a.rms[i];
  const env = new Float32Array(n);
  let sum = 0, sq = 0;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1);
    env[i] = (pre[hi] - pre[lo]) / (hi - lo);
    sum += env[i]; sq += env[i] * env[i];
  }
  const mean = sum / Math.max(1, n), sd = Math.sqrt(Math.max(1e-12, sq / Math.max(1, n) - mean * mean));
  for (let i = 0; i < n; i++) env[i] = (env[i] - mean) / sd;
  return env;
}

/** loudness z-score at time t (ms), over windows of `windowMs`: for contrast-aware star adjustment */
export function loudnessAt(a: Analysis, windowMs: number): (t: number) => number {
  const env = loudnessEnvelope(a, windowMs);
  return (t) => env[Math.max(0, Math.min(env.length - 1, Math.round(t / 1000 / a.frameDur)))] ?? 0;
}

/**
 * What contrast follows: the learned music-energy curve (energy.ts) or loudness alone. 'auto' uses
 * energy from 6K up. On held-out songs energy made the density shape closer to the ranked maps for
 * 7K (r 0.511 -> 0.549; 6+ stars 0.606 -> 0.645, rhythm F1 0.760 -> 0.766) and 6K (0.479 -> 0.489),
 * and the star adjustment closer to human easier difficulties (7K shape 0.225 -> 0.243, 6K 0.006 ->
 * 0.068); 4K did not gain (0.499 -> 0.499) and keeps loudness.
 */
export let CONTRAST_SOURCE: 'auto' | 'energy' | 'loudness' = 'auto';
export function _setContrastSource(s: 'auto' | 'energy' | 'loudness') { CONTRAST_SOURCE = s; }
/** the contrast source used for a key count */
export function contrastSourceFor(keys: number): 'energy' | 'loudness' {
  return CONTRAST_SOURCE === 'auto' ? (keys >= 6 ? 'energy' : 'loudness') : CONTRAST_SOURCE;
}

/**
 * The learned energy curve as a per-frame z-score (measures of the map's first red line; linear
 * between measure centres), the same shape as loudnessEnvelope.
 */
export function energyEnvelope(a: Analysis, map: Beatmap, onsets?: Onset[]): Float32Array {
  const red = map.timingPoints.find((p) => p.uninherited && p.beatLength > 0);
  const bar = (red?.beatLength ?? 500) * 4, off = red?.time ?? 0;
  const dur = a.rms.length * a.frameDur * 1000;
  const { starts, energy } = energyCurve(a, onsets ?? detectOnsets(a, 0.5), bar, off, 0, dur);
  const env = new Float32Array(a.rms.length);
  if (!starts.length) return env;
  const centres = starts.map((s) => s + bar / 2);
  let k = 0;
  for (let f = 0; f < env.length; f++) {
    const t = f * a.frameDur * 1000;
    while (k + 1 < centres.length && centres[k + 1] <= t) k++;
    if (t <= centres[0]) env[f] = energy[0];
    else if (k + 1 >= centres.length) env[f] = energy[centres.length - 1];
    else { const u = (t - centres[k]) / (centres[k + 1] - centres[k]); env[f] = energy[k] * (1 - u) + energy[k + 1] * u; }
  }
  return env;
}

/** contrast-aware star adjustment: the song's intensity at time t for this map (CONTRAST_SOURCE) */
export function loudnessForMap(a: Analysis, map: Beatmap): (t: number) => number {
  const red = map.timingPoints.find((p) => p.uninherited && p.beatLength > 0);
  if (contrastSourceFor(getKeys(map)) === 'energy') {
    const env = energyEnvelope(a, map);
    return (t) => env[Math.max(0, Math.min(env.length - 1, Math.round(t / 1000 / a.frameDur)))] ?? 0;
  }
  return loudnessAt(a, (red?.beatLength ?? 500) * 4);
}

export function learnedRhythm(a: Analysis, map: Beatmap, divisors: number | number[], onsets: Onset[], stars: number, count: number, contrast = 0, windowMs = 2000): GridOnset[] {
  const divs = typeof divisors === 'number' ? [divisors] : divisors;
  const finest = Math.max(...divs);
  const ctx = rhythmContext(a, onsets);
  const end = a.rms.length * a.frameDur * 1000;
  const first = onsets[0]?.time ?? 0, last = onsets[onsets.length - 1]?.time ?? end;
  const ticks = gridTicksFor(map, divs, Math.max(0, first - 100), Math.min(end, last + 100));
  const cur = { i: 0 };
  // the key count's own model when there is one (mappers place notes differently in 4K and 7K)
  const rhythmModel = RHYTHM_MODELS_BY_KEYS[getKeys(map)] ?? RHYTHM_MODEL;
  const env = contrast ? (contrastSourceFor(getKeys(map)) === 'energy' ? energyEnvelope(a, map, onsets) : loudnessEnvelope(a, windowMs)) : null;
  const scored = ticks.map((tk) => {
    const x = tickFeatures(ctx, map, tk, stars, cur, finest);
    const f = Math.max(0, Math.min(a.flux.length - 1, tk.frame));
    const p0 = rhythmScore(rhythmModel, x);
    // contrast: shift the tick's log-odds by the loudness of its surroundings
    const p = env ? 1 / (1 + Math.exp(-(Math.log(Math.max(1e-6, p0) / Math.max(1e-6, 1 - p0)) + contrast * env[f]))) : p0;
    // accent for chord sizes: the model's confidence mixed with the onset strength there
    const strength = 0.5 * p0 + 0.5 * Math.min(1, x[6]);
    return { g: { time: tk.t, frame: f, snapped: tk.t, beatIndex: tk.beatIndex, beatFrac: tk.beatFrac, strength, centroid: a.centroid[f] ?? 0.5 } as GridOnset, p };
  });
  const keep = Math.max(1, Math.min(scored.length, count));
  const thr = [...scored].sort((x, y) => y.p - x.p)[keep - 1]?.p ?? 0;
  return scored.filter((x) => x.p >= thr).map((x) => x.g);
}

/** typical star rating of each preset tier (auto style uses it when no target is given) */
const TIER_STARS: Record<Difficulty, number> = { easy: 1.5, normal: 2.3, hard: 3.3, insane: 4.5, expert: 5.8 };

/** The style model's average probabilities over the whole song (in STYLE_MODEL.classes order). */
export function songStyleProbs(a: Analysis, keys: number, stars: number, bpm?: number, offset?: number): number[] {
  const tempo = bpm ? { bpm, offset: offset ?? 0 } : estimateTempo(a);
  const beatLen = 60000 / tempo.bpm;
  const ctx = songContext(a, detectOnsets(a, 0.5));
  const start = ((tempo.offset % beatLen) + beatLen) % beatLen;
  const n = Math.max(1, Math.floor((a.rms.length * a.frameDur * 1000 - start) / (beatLen * 4)));
  const sum = new Array(STYLE_MODEL.classes.length).fill(0);
  for (let m = 0; m < n; m++) {
    const t0 = start + m * beatLen * 4;
    predictStyle(styleModelFor(keys), measureFeatures(ctx, t0, t0 + beatLen * 4, 4, tempo.bpm, stars, keys)).forEach((v, i) => { sum[i] += v / n; });
  }
  return sum;
}

/** Learned style per measure (4 beats), smoothed over neighbours so sections stay coherent. */
/** auto style sizes chords through the ranked distribution (chordtargets.ts) */
let CHORD_TARGETS_ON = true;
const CHORD_TARGET_KEYS = [7];
/** benchmarks only */
export function _setChordTargets(on: boolean) { CHORD_TARGETS_ON = on; }

/** from this target, speed mode in 4K/5K may use 1/4-beat minijacks (6K and up: 7.5) */
let MINIJACK_STARS_LOW_KEYS = 7.5;
/** benchmarks only */
export function _setMinijackStarsLowKeys(v: number) { MINIJACK_STARS_LOW_KEYS = v; }

export function autoStyles(a: Analysis, offset: number, beatLen: number, keys: number, stars: number, jackBias: number, durationMs: number, speedBias = 0): StyleDef[] {
  const ctx = songContext(a, detectOnsets(a, 0.5));
  const bpm = 60000 / beatLen;
  const n = Math.max(1, Math.ceil((durationMs - offset) / (beatLen * 4)));
  const probs: number[][] = [];
  for (let m = 0; m < n; m++) {
    const t0 = offset + m * beatLen * 4;
    probs.push(predictStyle(styleModelFor(keys), measureFeatures(ctx, t0, t0 + beatLen * 4, 4, bpm, stars, keys)));
  }
  const cj = STYLE_MODEL.classes.indexOf('chordjack');
  const js = STYLE_MODEL.classes.indexOf('jumpstream');
  return probs.map((_, m) => {
    // smooth over -2..+2 measures
    const p = STYLE_MODEL.classes.map((_, c) => {
      let s = 0, w = 0;
      for (let d = -2; d <= 2; d++) { const q = probs[m + d]; if (!q) continue; const wt = d === 0 ? 3 : Math.abs(d) === 1 ? 2 : 1; s += q[c] * wt; w += wt; }
      return s / w;
    });
    if (jackBias > 0 && cj >= 0) {
      const t0 = offset + m * beatLen * 4;
      const f0 = Math.floor(t0 / 1000 / a.frameDur), f1 = Math.floor((t0 + beatLen * 4) / 1000 / a.frameDur);
      let r = 0;
      for (let f = f0; f < f1 && f < a.rms.length; f++) r += a.rms[f];
      const loud = r / Math.max(1, f1 - f0) / Math.max(1e-6, ctx.rmsMean);
      if (loud > 0.9) p[cj] += jackBias * 0.6;
    }
    const st = STYLE_MODEL.classes.indexOf('stream');
    if (speedBias > 0) { if (js >= 0) p[js] += speedBias * 0.3; if (st >= 0) p[st] += speedBias * 0.3; const c = STYLE_MODEL.classes.indexOf('chordjack'); if (c >= 0) p[c] -= speedBias * 0.3; }
    return STYLES[STYLE_MODEL.classes[p.indexOf(Math.max(...p))]];
  });
}

function streamFill(map: Beatmap, a: Analysis, grid: GridOnset[], beatLen: number, divisor: number, amountAt: number | ((t: number) => number), rand: () => number): GridOnset[] {
  const step = beatLen / divisor;
  const out: GridOnset[] = [...grid];
  for (let i = 0; i + 1 < grid.length; i++) {
    const g0 = grid[i], g1 = grid[i + 1];
    const gap = g1.snapped - g0.snapped;
    const amount = typeof amountAt === 'number' ? amountAt : amountAt(g0.snapped);
    if (amount <= 0) continue;
    if (gap < 2 * step - 2 || gap > beatLen * (1 + amount) + 2) continue;
    if (rand() > amount) continue;
    for (let t = g0.snapped + step; t < g1.snapped - step / 2; t += step) {
      const tt = snapTime(map, t, divisor);
      const f = Math.floor(tt / 1000 / a.frameDur);
      if ((a.rms[f] ?? 0) < 0.3 - 0.15 * amount) continue;
      const r = redLineAt(map, tt)!;
      const bi = Math.round(((tt - r.time) / r.beatLength) * divisor) / divisor;
      const beatIndex = Math.floor(bi + 1e-6);
      out.push({
        time: tt, frame: f, snapped: tt, beatIndex, beatFrac: Math.round((bi - beatIndex) * divisor) / divisor,
        strength: Math.min(g0.strength, g1.strength) * 0.5, centroid: (g0.centroid + g1.centroid) / 2,
      });
    }
  }
  return out.sort((x, y) => x.snapped - y.snapped);
}

function estimateTempoOffsetOnly(a: Analysis, bpm: number): number {
  return Math.round((beatPhase(a, bpm) * a.frameDur + ONSET_LATENCY(a)) * 1000);
}

export function addLongNotes(
  map: Beatmap, notes: Note[], a: Analysis, beatLen: number, divisor: number,
  lnRatio: number, rand: () => number,
): void {
  const keys = notes.reduce((m, n) => Math.max(m, n.column + 1), 1);
  const byCol: Note[][] = Array.from({ length: keys }, () => []);
  for (const n of sortNotes([...notes])) byCol[n.column].push(n);
  const step = beatLen / divisor;
  for (const col of byCol) {
    for (let i = 0; i < col.length; i++) {
      const n = col[i];
      const next = col[i + 1]?.time ?? n.time + beatLen * 4;
      const room = next - n.time - step; // leave one grid step before the next note
      if (room < beatLen * 0.5) continue;
      // how long does the loudness stay up after the onset?
      const f0 = Math.floor(n.time / 1000 / a.frameDur);
      const base = a.rms[f0] ?? 0;
      if (base < 0.15) continue;
      let f = f0;
      const maxF = Math.floor((n.time + room) / 1000 / a.frameDur);
      while (f < maxF && f < a.rms.length && a.rms[f] > base * 0.6 && a.flux[f] < 0.5 + (f === f0 ? 1 : 0)) f++;
      const sustain = f * a.frameDur * 1000 - n.time;
      if (sustain < beatLen * 0.5) continue;
      if (rand() > lnRatio * 2) continue; // lnRatio ~ share of eligible notes
      const end = snapTime(map, n.time + Math.min(sustain, room), divisor);
      if (end - n.time >= step) n.endTime = end;
    }
  }
}

/** Convenience: decode-agnostic entry point from raw mono samples. */
export function autoMap(samples: Float32Array, sampleRate: number, opts: AutoMapOptions): { map: Beatmap; analysis: Analysis } {
  const a = analyze(samples, sampleRate, (p) => opts.onProgress?.('analyze', p));
  return { map: generateFromAnalysis(a, opts), analysis: a };
}

export { PRESETS };
