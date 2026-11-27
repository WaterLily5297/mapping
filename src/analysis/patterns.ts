/**
 * Pattern classifier for osu!mania, any key count (1K..18K).
 *
 * Terminology and detection rules follow community sources:
 *   - osu! wiki, Beatmap/Pattern/osu!mania (Stream, Jack, Chord, Trill, Anchor, Hold note)
 *     https://github.com/ppy/osu-wiki/tree/master/wiki/Beatmap/Pattern/osu!mania
 *   - osu! user tags for osu!mania (style/jumpstream, skillset/speedjack, style/LN release...)
 *     https://github.com/ppy/osu-wiki/blob/master/wiki/Beatmap/Beatmap_tags/en.md
 *   - Etterna MinaCalc pattern mods (hand split, minijack, flam/grace, running man)
 *     https://github.com/etternagame/etterna/tree/master/src/Etterna/MinaCalc
 *   - Interlude (YAVSRG) pattern finder: 4K vs 7K naming, quadstream, minitrill,
 *     double stream, light/dense chordstream, brackets, chord rolls, "Hybrid"/"Tech" categories
 *     https://github.com/YAVSRG/YAVSRG/tree/main/prelude/src/Calculator/Patterns
 *   - ManiaMapAnalyser (LN coordination / column lock, shield, release, LN density)
 *     https://github.com/LeoBlackMT/osumania_map_analyser
 *   - Columnist (Kominaru): whole-chart statistics and tag rules validated against osu!
 *     user-tag votes — ported in ./chartStats.ts (Apache-2.0)
 * No code is copied; the rules are re-implemented for any key count.
 *
 * Pipeline
 *   notes -> rows (chords; grace notes merged)            rowFeatures()
 *         -> per-row features (jack, trill, roll, hands, LN state, snap)
 *         -> every 8-row window in a phrase gets a label     windowStats() + decide()
 *         -> each row takes the label of its most uniform window (sharp boundaries)
 *         -> smoothing -> sections (+ tags) -> map summary, category, suggested osu! tags
 */
import { type Beatmap, type Note, getKeys, isLN, sortNotes } from '../core/beatmap';
import { redLineAt, snapTime } from '../core/timing';
import { chartStats, tagScores, ruleSlot, slotScores, categoryScores, type ChartStats, type Slot } from './chartStats';

// ================================================================ vocabulary

export type PatternType =
  // single-note streams
  | 'stream' | 'roll' | 'trill' | 'minitrill'
  // 4K-style chordstreams
  | 'jumpstream' | 'handstream' | 'quadstream'
  // non-4K chordstreams (7K naming, used for 5K+)
  | 'doublestream' | 'lightchordstream' | 'densechordstream' | 'brackets' | 'chordroll'
  // chord trills
  | 'jumptrill' | 'splittrill'
  // jacks
  | 'jack' | 'longjack' | 'chordjack'
  // long notes
  | 'inverse' | 'lncoordination' | 'lnrelease' | 'lndensity' | 'ln'
  | 'slow';

/** Interlude-style core pattern */
export type CorePattern = 'Stream' | 'Chordstream' | 'Jacks' | 'LN' | 'Slow';
/** MinaCalc-style skillset bucket */
export type SkillGroup = 'Stream' | 'Jumpstream' | 'Handstream' | 'Chordstream' | 'Jackspeed' | 'Chordjack' | 'Technical' | 'LN' | 'Slow';

interface Info { name: string; color: string; core: CorePattern; group: SkillGroup; description: string }

export const PATTERN_INFO: Record<PatternType, Info> = {
  stream:           { name: 'Stream',            color: '#5aa9ff', core: 'Stream',      group: 'Stream',      description: 'constant single notes, no jacks' },
  roll:             { name: 'Roll',              color: '#7d8cff', core: 'Stream',      group: 'Technical',   description: 'single notes going across the columns in sequence (1234 / 4321)' },
  trill:            { name: 'Trill',             color: '#b25dff', core: 'Stream',      group: 'Technical',   description: '3+ notes alternating between two columns' },
  minitrill:        { name: 'Minitrill',         color: '#9a6bff', core: 'Stream',      group: 'Technical',   description: 'stream made of short trills (a-b-a then elsewhere)' },
  jumpstream:       { name: 'Jumpstream',        color: '#3dd6c6', core: 'Chordstream', group: 'Jumpstream',  description: 'stream with jumps (2-note chords) — 4K term' },
  handstream:       { name: 'Handstream',        color: '#3ddc84', core: 'Chordstream', group: 'Handstream',  description: 'stream with hands (3-note chords), may include jumps — 4K term' },
  quadstream:       { name: 'Quadstream',        color: '#a5e05a', core: 'Chordstream', group: 'Handstream',  description: 'stream with quads, which form minijacks with their neighbours — 4K term' },
  doublestream:     { name: 'Double stream',     color: '#2fc0b0', core: 'Chordstream', group: 'Chordstream', description: 'two streams at once (consecutive 2-note chords, no jacks) — 5K+' },
  lightchordstream: { name: 'Light chordstream', color: '#4fd39a', core: 'Chordstream', group: 'Chordstream', description: 'chords alternating with single notes — 5K+' },
  densechordstream: { name: 'Dense chordstream', color: '#8fdc4f', core: 'Chordstream', group: 'Chordstream', description: 'consecutive chords without jacks — 5K+' },
  brackets:         { name: 'Brackets',          color: '#c3e04f', core: 'Chordstream', group: 'Chordstream', description: 'big chords (3+) alternating like several trills at once — 5K+' },
  chordroll:        { name: 'Chord roll',        color: '#68b8a8', core: 'Chordstream', group: 'Technical',   description: 'chords sweeping across the columns in one direction' },
  jumptrill:        { name: 'Jumptrill',         color: '#d77dff', core: 'Chordstream', group: 'Technical',   description: 'two chords alternating, each chord played by one hand ([12][34])' },
  splittrill:       { name: 'Split trill',       color: '#ff7ad9', core: 'Chordstream', group: 'Technical',   description: 'two chords alternating, each chord needs both hands ([13][24])' },
  jack:             { name: 'Jacks',             color: '#ff5a5a', core: 'Jacks',       group: 'Jackspeed',   description: 'repeated notes in the same column (minijacks / short jacks)' },
  longjack:         { name: 'Longjack',          color: '#ff3d6e', core: 'Jacks',       group: 'Jackspeed',   description: '4+ consecutive notes in one column' },
  chordjack:        { name: 'Chordjack',         color: '#ff9b3d', core: 'Jacks',       group: 'Chordjack',   description: 'chords that keep forming jacks' },
  inverse:          { name: 'Inverse',           color: '#ffd84d', core: 'LN',          group: 'LN',          description: 'LNs extend to right before the next note; the gaps are the "notes"' },
  lncoordination:   { name: 'LN coordination',   color: '#e8c06a', core: 'LN',          group: 'LN',          description: 'holding long notes while hitting other notes (incl. column lock)' },
  lnrelease:        { name: 'LN release',        color: '#f0a84d', core: 'LN',          group: 'LN',          description: 'LNs with staggered, varied release timings' },
  lndensity:        { name: 'LN density',        color: '#d9b23a', core: 'LN',          group: 'LN',          description: 'dense LN streams without breaks' },
  ln:               { name: 'LN',                color: '#b8993a', core: 'LN',          group: 'LN',          description: 'other LN-heavy patterning' },
  slow:             { name: 'Slow',              color: '#6b7488', core: 'Slow',        group: 'Slow',        description: 'quarter notes or slower' },
};

// ================================================================ config

export interface PatternConfig {
  before: number;
  after: number;
  /** a gap longer than this many beats starts a new phrase */
  breakBeats: number;
  /** median gap >= this many beats => slow */
  slowBeats: number;
  /** grace notes: rows closer than min(graceMs, beat * graceBeats) with disjoint columns merge into a chord */
  graceMs: number;
  graceBeats: number;
  lnFrac: number;
  heldFrac: number;
  inverseFrac: number;
  releaseFrac: number;
  jackFrac: number;
  chordjackSize: number;
  trillFrac: number;
  minitrillFrac: number;
  rollFrac: number;
  chordRollFrac: number;
  handFrac: number;
  jumpFrac: number;
  quadFrac: number;
  minSectionRows: number;
  anchorShare: number;
}

export const DEFAULT_CONFIG: PatternConfig = {
  before: 3,
  after: 4,
  breakBeats: 2,
  slowBeats: 0.99,
  graceMs: 30,
  graceBeats: 1 / 8,
  lnFrac: 0.45,
  heldFrac: 0.5,
  inverseFrac: 0.6,
  releaseFrac: 0.6,
  jackFrac: 0.4,
  chordjackSize: 1.8,
  trillFrac: 0.7,
  minitrillFrac: 0.45,
  rollFrac: 0.6,
  chordRollFrac: 0.5,
  handFrac: 0.15,
  jumpFrac: 0.2,
  quadFrac: 0.15,
  minSectionRows: 4,
  anchorShare: 0.4,
};

// ================================================================ hands

/** Columns played by the left hand (the rest are right hand). Odd key counts: the middle column is "either" (thumb). */
export function leftHandKeys(K: number): number {
  return Math.max(1, Math.floor(K / 2));
}

/** 0 = left, 1 = right, -1 = middle column of an odd key count (either hand) */
export function handOf(col: number, K: number): -1 | 0 | 1 {
  if (K % 2 === 1 && col === (K - 1) / 2) return -1;
  return col < leftHandKeys(K) ? 0 : 1;
}

/** true when every note of the chord can be played by one hand */
export function isOneHand(cols: number[], K: number): boolean {
  const hands = new Set(cols.map((c) => handOf(c, K)).filter((h) => h !== -1));
  return hands.size <= 1;
}

// ================================================================ rows

export interface Row {
  index: number;
  time: number;
  notes: Note[];
  cols: number[];
  mask: number;
  size: number;
  /** ms since previous row (Infinity for the first) */
  gap: number;
  beatLength: number;
  /** snap denominator of this row's time (1,2,3,4,6,8,12,16) or 0 if unsnapped */
  snap: number;
  /** grace notes were merged into this row */
  grace: boolean;
  /** shares a column with the previous row */
  jack: boolean;
  /** same columns as two rows ago and none of the previous row's */
  trill: boolean;
  /** a-b-a: same columns as two rows ago (looser than trill) */
  abA: boolean;
  /** 4 single notes stepping +-1 column (cyclic) in one direction */
  roll: boolean;
  /** chord sweeping: column ranges move in one direction without overlap for 2 steps */
  chordRoll: boolean;
  /** another column is inside a long hold (>= 1 beat) at this row's time */
  held: boolean;
  /** a held column's same-hand neighbour is hit in this row (column lock) */
  colLock: boolean;
  lnNotes: number;
  inverseLNs: number;
  lnWithNext: number;
  /** LNs in this row whose release does not line up with any other note or release */
  isolatedTails: number;
  /** shield: a note in this row's column ended <= 1/4 beat before an LN head here (or vice versa) */
  shields: number;
  reverseShields: number;
}

const bits = (cols: number[]) => cols.reduce((m, c) => m | (1 << c), 0);
const SNAPS = [1, 2, 3, 4, 6, 8, 12, 16];

export function rowFeatures(map: Beatmap, cfg: PatternConfig = DEFAULT_CONFIG): Row[] {
  const K = getKeys(map);
  const notes = sortNotes([...map.notes]);
  const hasTiming = !!redLineAt(map, 0);

  // 1. raw rows (same time +-1 ms)
  const raw: { time: number; notes: Note[] }[] = [];
  for (const n of notes) {
    const last = raw[raw.length - 1];
    if (last && Math.abs(last.time - n.time) <= 1) last.notes.push(n);
    else raw.push({ time: n.time, notes: [n] });
  }

  // 2. merge isolated grace notes / flams into the chord they belong to
  const merged: { time: number; notes: Note[]; grace: boolean }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const prev = merged[merged.length - 1];
    if (prev) {
      const beat = redLineAt(map, r.time)?.beatLength ?? 500;
      const gap = r.time - prev.time;
      const lim = Math.min(cfg.graceMs, beat * cfg.graceBeats);
      const nextGap = i + 1 < raw.length ? raw[i + 1].time - r.time : Infinity;
      const prevGap = merged.length > 1 ? prev.time - merged[merged.length - 2].time : Infinity;
      const disjoint = !r.notes.some((n) => prev.notes.some((p) => p.column === n.column));
      // a grace is a tiny gap surrounded by much larger gaps (otherwise it is a fast burst)
      if (gap <= lim && disjoint && nextGap >= gap * 3 && prevGap >= gap * 3) {
        prev.notes.push(...r.notes);
        prev.grace = true;
        continue;
      }
    }
    merged.push({ time: r.time, notes: [...r.notes], grace: false });
  }

  // next note per column (for inverse / shields)
  const nextInCol = new Map<Note, Note>();
  const lastByCol: (Note | undefined)[] = new Array(K);
  for (const n of notes) {
    const p = lastByCol[n.column];
    if (p) nextInCol.set(p, n);
    lastByCol[n.column] = n;
  }
  const headTimes = new Set(notes.map((n) => n.time));
  const tailCount = new Map<number, number>();
  for (const n of notes) if (isLN(n)) tailCount.set(n.endTime!, (tailCount.get(n.endTime!) ?? 0) + 1);

  const lns = notes.filter(isLN);
  let lnPtr = 0;
  const active: Note[] = [];
  const rows: Row[] = [];

  merged.forEach((m, idx) => {
    const beatLength = redLineAt(map, m.time)?.beatLength ?? 500;
    const cols = [...new Set(m.notes.map((n) => n.column))].sort((a, b) => a - b);
    let snap = 0;
    if (hasTiming) {
      for (const d of SNAPS) if (Math.abs(snapTime(map, m.time, d) - m.time) <= 2) { snap = d; break; }
    }
    const r: Row = {
      index: idx, time: m.time, notes: m.notes, cols, mask: bits(cols), size: cols.length,
      gap: idx ? m.time - merged[idx - 1].time : Infinity, beatLength, snap, grace: m.grace,
      jack: false, trill: false, abA: false, roll: false, chordRoll: false, held: false, colLock: false,
      lnNotes: 0, inverseLNs: 0, lnWithNext: 0, isolatedTails: 0, shields: 0, reverseShields: 0,
    };
    const quarter = beatLength / 4 + 5;
    for (const n of m.notes) {
      const next = nextInCol.get(n);
      if (isLN(n)) {
        r.lnNotes++;
        if (next) {
          r.lnWithNext++;
          const span = next.time - n.time;
          // inverse: release within 1/4 beat of the next note, and the gap is not longer than the LN
          if (next.time - n.endTime! <= quarter && (n.endTime! - n.time) / span >= 0.5) r.inverseLNs++;
          // reverse shield: a note right after this LN's release in the same column
          if (next.time - n.endTime! <= quarter && !isLN(next)) r.reverseShields++;
        }
        if ((tailCount.get(n.endTime!) ?? 0) === 1 && !headTimes.has(n.endTime!)) r.isolatedTails++;
      } else if (next && isLN(next) && next.time - n.time <= quarter) {
        // shield: a note right before an LN head in the same column
        r.shields++;
      }
    }
    while (lnPtr < lns.length && lns[lnPtr].time < m.time - 1) active.push(lns[lnPtr++]);
    for (let i = active.length - 1; i >= 0; i--) if (active[i].endTime! <= m.time) active.splice(i, 1);
    const holds = active.filter((h) => !(r.mask & (1 << h.column)) && h.endTime! > m.time && h.endTime! - h.time >= beatLength * 0.99);
    r.held = holds.length > 0;
    // column lock: tapping (rice, not LN heads) the same-hand neighbour of a held column
    const taps = m.notes.filter((x) => !isLN(x)).map((x) => x.column);
    r.colLock = holds.some((h) => taps.some((c) => Math.abs(c - h.column) === 1 && handOf(c, K) === handOf(h.column, K)));
    rows.push(r);
  });

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const p = rows[i - 1];
    r.jack = (r.mask & p.mask) !== 0;
    if (i >= 2) {
      const pp = rows[i - 2];
      r.abA = r.mask === pp.mask && (r.mask & p.mask) === 0;
      r.trill = r.abA && i >= 3 && rows[i - 3].mask === p.mask;
      // chord roll: ranges strictly left or right of each other, same direction twice
      if (r.size >= 2 && p.size >= 2 && pp.size >= 2) {
        const dir = (a: Row, b: Row) => (b.cols[0] > a.cols[a.size - 1] ? 1 : b.cols[b.size - 1] < a.cols[0] ? -1 : 0);
        const d1 = dir(pp, p);
        const d2 = dir(p, r);
        r.chordRoll = d1 !== 0 && d1 === d2;
      }
    }
    if (i >= 3 && K > 2) {
      const seq = rows.slice(i - 3, i + 1);
      if (seq.every((x) => x.size === 1)) {
        const d = seq.slice(1).map((x, j) => (((x.cols[0] - seq[j].cols[0]) % K) + K) % K);
        r.roll = d.every((x) => x === 1) || d.every((x) => x === K - 1);
      }
    }
  }
  return rows;
}

// ================================================================ windows

export interface WindowStats {
  rows: number;
  notes: number;
  meanSize: number;
  frac: { s1: number; s2: number; s3: number; s4: number };
  jackFrac: number;
  trillFrac: number;
  abAFrac: number;
  rollFrac: number;
  chordRollFrac: number;
  lnFrac: number;
  heldFrac: number;
  inverseFrac: number;
  releaseFrac: number;
  lnLengthCV: number;
  medianGap: number;
  beatLength: number;
  /** share of trill rows whose chords are one-handed */
  oneHandTrill: number;
  /** longest run of consecutive rows sharing one column */
  maxJackRun: number;
  /** jack ratio of transitions that do not touch a 4+ chord (4K quadstream vs chordjack) */
  nonQuadJackFrac: number;
}

function median(a: number[]): number {
  if (!a.length) return Infinity;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

export function windowStats(win: Row[], K: number): WindowStats {
  const n = win.length;
  const notes = win.reduce((s, r) => s + r.notes.length, 0);
  const trans = win.slice(1);
  const lnNotes = win.reduce((s, r) => s + r.lnNotes, 0);
  const lnWithNext = win.reduce((s, r) => s + r.lnWithNext, 0);
  const inv = win.reduce((s, r) => s + r.inverseLNs, 0);
  const iso = win.reduce((s, r) => s + r.isolatedTails, 0);
  const late = win.slice(2);
  const trills = late.filter((r) => r.trill || r.abA);
  const lnLens = win.flatMap((r) => r.notes.filter(isLN).map((x) => x.endTime! - x.time));
  const lnMean = lnLens.length ? lnLens.reduce((a, b) => a + b, 0) / lnLens.length : 0;
  const lnSd = lnLens.length ? Math.sqrt(lnLens.reduce((a, b) => a + (b - lnMean) ** 2, 0) / lnLens.length) : 0;

  let maxJackRun = 1;
  for (let c = 0; c < K; c++) {
    let run = 0;
    for (const r of win) {
      run = r.mask & (1 << c) ? run + 1 : 0;
      maxJackRun = Math.max(maxJackRun, run);
    }
  }
  const nonQuad = trans.filter((r, j) => r.size < 4 && win[j].size < 4);
  return {
    rows: n,
    notes,
    meanSize: notes / Math.max(1, n),
    frac: {
      s1: win.filter((r) => r.size === 1).length / n,
      s2: win.filter((r) => r.size === 2).length / n,
      s3: win.filter((r) => r.size === 3).length / n,
      s4: win.filter((r) => r.size >= 4).length / n,
    },
    jackFrac: trans.length ? trans.filter((r) => r.jack).length / trans.length : 0,
    trillFrac: n > 3 ? win.slice(3).filter((r) => r.trill).length / (n - 3) : 0,
    abAFrac: late.length ? late.filter((r) => r.abA).length / late.length : 0,
    rollFrac: n > 3 ? win.slice(3).filter((r) => r.roll).length / (n - 3) : 0,
    chordRollFrac: late.length ? late.filter((r) => r.chordRoll).length / late.length : 0,
    lnFrac: notes ? lnNotes / notes : 0,
    heldFrac: win.filter((r) => r.held).length / n,
    // LNs at the very end of a column have no "next note" and cannot be judged
    inverseFrac: lnWithNext ? inv / lnWithNext : lnNotes ? 1 : 0,
    releaseFrac: lnNotes ? iso / lnNotes : 0,
    lnLengthCV: lnMean ? lnSd / lnMean : 0,
    medianGap: median(trans.map((r) => r.gap)),
    beatLength: median(win.map((r) => r.beatLength)),
    oneHandTrill: trills.length ? trills.filter((r) => isOneHand(r.cols, K)).length / trills.length : 0,
    maxJackRun,
    nonQuadJackFrac: nonQuad.length ? nonQuad.filter((r) => r.jack).length / nonQuad.length : 0,
  };
}

export function decide(s: WindowStats, K: number, cfg: PatternConfig = DEFAULT_CONFIG): PatternType {
  // ---- long notes first: rice rules would misread LN maps
  if (s.lnFrac >= cfg.lnFrac || s.heldFrac >= cfg.heldFrac) {
    if (s.inverseFrac >= cfg.inverseFrac && s.lnFrac >= cfg.lnFrac) return 'inverse';
    if (s.heldFrac >= cfg.heldFrac) return 'lncoordination';
    if (s.lnFrac >= cfg.lnFrac && s.releaseFrac >= cfg.releaseFrac && s.lnLengthCV >= 0.25) return 'lnrelease';
    if (s.medianGap < s.beatLength / 2 - 1) return 'lndensity'; // faster than 1/2
    return 'ln';
  }
  if (s.rows < 3 || s.medianGap >= s.beatLength * cfg.slowBeats) return 'slow';

  // ---- jacks (4K quads always jack their neighbours: that is quadstream, not chordjack)
  if (s.jackFrac >= cfg.jackFrac) {
    if (K === 4 && s.frac.s4 >= cfg.quadFrac && s.frac.s4 <= 0.6 && s.nonQuadJackFrac <= 0.2) return 'quadstream';
    if (s.meanSize >= cfg.chordjackSize) return 'chordjack';
    if (s.maxJackRun >= 4) return 'longjack';
    return 'jack';
  }

  // ---- trills: two alternating note sets
  if (s.trillFrac >= cfg.trillFrac) {
    if (s.meanSize <= 1.2) return 'trill';
    // wiki: jumptrill = each chord played by one hand; brackets (non-4K) = several trills at once
    if (s.oneHandTrill >= 0.5) return 'jumptrill';
    return K >= 5 && s.meanSize >= 3 ? 'brackets' : 'splittrill';
  }
  if (K > 2 && s.rollFrac >= cfg.rollFrac && s.meanSize <= 1.3) return 'roll';
  if (K >= 5 && s.chordRollFrac >= cfg.chordRollFrac) return 'chordroll';

  // ---- streams by chord size
  const chords = s.frac.s2 + s.frac.s3 + s.frac.s4;
  if (K <= 4) {
    if (K === 4 && s.frac.s4 >= cfg.quadFrac) return 'quadstream';
    if (s.frac.s3 + s.frac.s4 >= cfg.handFrac) return 'handstream';
    if (s.frac.s2 >= cfg.jumpFrac) return 'jumpstream';
  } else {
    if (chords >= cfg.jumpFrac) {
      if (s.frac.s1 < 0.35) {
        if (s.meanSize >= 3 && s.frac.s3 + s.frac.s4 >= 0.6) return 'brackets';
        if (s.frac.s2 >= 0.6) return 'doublestream';
        return 'densechordstream';
      }
      return 'lightchordstream';
    }
  }
  if (s.meanSize <= 1.2 && s.abAFrac >= cfg.minitrillFrac) return 'minitrill';
  return 'stream';
}

// ================================================================ sections

export interface SectionTags {
  /** runs of exactly 2 notes in one column */
  minijacks: number;
  /** longest run of consecutive notes in one column */
  longestJack: number;
  /** columns holding a big share of the section's notes (0-based) */
  anchors: number[];
  /** grace notes / flams merged into chords */
  graces: number;
  shields: number;
  reverseShields: number;
  /** rows where a held column's same-hand neighbour is tapped */
  columnLock: number;
  /** trills: one- or two-handed */
  hands?: 'one-hand' | 'two-hand';
  /** mixes 1/3-family and 1/4-family snaps, or has unsnapped notes */
  complexSnap: boolean;
}

export interface PatternSection {
  type: PatternType;
  start: number;
  /** last note end (including LN ends) */
  end: number;
  rows: number;
  notes: number;
  nps: number;
  /** "1/4 BPM": BPM at which this section would be 1/4 notes */
  speedBpm: number;
  rowsPerBeat: number;
  bpm: number;
  /** readable speed, e.g. "1/4 @ 180" */
  speed: string;
  /** kept for compatibility: tags.anchors */
  anchors: number[];
  /** jack transitions inside the section */
  jacks: number;
  tags: SectionTags;
  firstRow: number;
  lastRow: number;
}

export interface SuggestedTag {
  tag: string;
  reason: string;
  /** rule score 0..1 (Columnist-style rule), when the tag has one */
  score?: number;
}

export interface PatternResult {
  keys: number;
  rows: Row[];
  labels: PatternType[];
  sections: PatternSection[];
  byTime: Partial<Record<PatternType, number>>;
  byNotes: Partial<Record<PatternType, number>>;
  byGroup: Partial<Record<SkillGroup, number>>;
  byCore: Partial<Record<CorePattern, number>>;
  dominant: PatternType[];
  /** LN share of notes, and the mode it implies (same rule as the slot, without SV) */
  lnRatio: number;
  mode: 'RC' | 'Hybrid' | 'LN';
  /** Interlude-style one-line category, e.g. "Jumpstream/Handstream", "Chordjack Hybrid", "Stream Tech" */
  category: string;
  /** osu! user tags (osu!mania) that fit this map, with the reason */
  suggestedTags: SuggestedTag[];
  /** whole-chart statistics (ms based) */
  stats: ChartStats;
  /** rule score per osu! user tag (0..1) */
  tagScores: Record<string, number>;
  /** tournament slot by rules: RC (rice), LN, HB (hybrid), SV */
  slot: Slot;
  /** tournament-style category scores (0..1) */
  categories: Record<string, number>;
}

export function classifyPatterns(map: Beatmap, cfg: PatternConfig = DEFAULT_CONFIG): PatternResult {
  const K = getKeys(map);
  const rows = rowFeatures(map, cfg);
  const lnRatio = map.notes.length ? map.notes.filter(isLN).length / map.notes.length : 0;
  // RC / Hybrid / LN from the same LN-share rule as the tournament slot (Columnist's, measured on mappools)
  const ss = slotScores({ ln_ratio: lnRatio });
  const mode = ss.LN >= ss.HB && ss.LN >= ss.RC ? 'LN' : ss.HB >= ss.RC ? 'Hybrid' : 'RC';
  const empty: PatternResult = {
    keys: K, rows, labels: [], sections: [], byTime: {}, byNotes: {}, byGroup: {}, byCore: {},
    dominant: [], lnRatio, mode, category: 'Uncategorised', suggestedTags: [],
    stats: {}, tagScores: {}, slot: 'RC', categories: {},
  };
  if (!rows.length) return empty;

  const phrase: number[] = [];
  let pid = 0;
  rows.forEach((r, i) => {
    if (i > 0 && r.gap > r.beatLength * cfg.breakBeats) pid++;
    phrase.push(pid);
  });
  const phraseStart: number[] = [];
  const phraseEnd: number[] = [];
  rows.forEach((_, i) => { phraseStart[i] = i > 0 && phrase[i - 1] === phrase[i] ? phraseStart[i - 1] : i; });
  for (let i = rows.length - 1; i >= 0; i--) phraseEnd[i] = i < rows.length - 1 && phrase[i + 1] === phrase[i] ? phraseEnd[i + 1] : i;

  // Every W-row window in a phrase gets a label; each row takes the label of the most
  // uniform window containing it (lowest variance of row features), so boundaries
  // between two patterns stay sharp instead of producing a mixed in-between label.
  const W = cfg.before + cfg.after + 1;
  // Uniformity is measured on locally smoothed features (+-2 rows): patterns that mix chord
  // sizes by nature (jumpstream, handstream) are then uniform too, and lose less often to
  // a neighbouring single-size pattern at boundaries.
  const smooth = rows.map((_, i) => {
    let size = 0, jack = 0, c = 0;
    for (let j = Math.max(phraseStart[i], i - 2); j <= Math.min(phraseEnd[i], i + 2); j++) {
      size += Math.min(rows[j].size, 4); jack += +rows[j].jack; c++;
    }
    return [size / c, jack / c];
  });
  const sig = (r: Row) => [...smooth[r.index], +r.trill, +r.roll, +r.chordRoll, +r.held, r.lnNotes / r.notes.length];
  const cache = new Map<number, { label: PatternType; impurity: number }>();
  const evalWindow = (a: number, b: number) => {
    const key = a * 1e6 + b;
    let w = cache.get(key);
    if (!w) {
      const rs = rows.slice(a, b + 1);
      const sigs = rs.slice(Math.min(3, rs.length - 1)).map(sig);
      let impurity = 0;
      for (let d = 0; d < sigs[0].length; d++) {
        const m = sigs.reduce((x, v) => x + v[d], 0) / sigs.length;
        impurity += sigs.reduce((x, v) => x + (v[d] - m) ** 2, 0) / sigs.length;
      }
      w = { label: decide(windowStats(rs, K), K, cfg), impurity };
      cache.set(key, w);
    }
    return w;
  };
  const raw: PatternType[] = rows.map((_, i) => {
    const ps = phraseStart[i];
    const pe = phraseEnd[i];
    if (pe - ps + 1 <= W) return evalWindow(ps, pe).label;
    let best: { label: PatternType; score: number } | null = null;
    for (let s = Math.max(ps, i - W + 1); s <= Math.min(i, pe - W + 1); s++) {
      const w = evalWindow(s, s + W - 1);
      const score = w.impurity + Math.abs(s + (W - 1) / 2 - i) * 1e-3;
      if (!best || score < best.score) best = { label: w.label, score };
    }
    return best!.label;
  });

  const labels = raw.map((l, i) => {
    const counts = new Map<PatternType, number>();
    for (let j = Math.max(0, i - 2); j <= Math.min(rows.length - 1, i + 2); j++) {
      if (phrase[j] !== phrase[i]) continue;
      counts.set(raw[j], (counts.get(raw[j]) ?? 0) + (j === i ? 1.5 : 1));
    }
    return [...counts].sort((x, y) => y[1] - x[1])[0]?.[0] ?? l;
  });

  type Seg = { type: PatternType; a: number; b: number };
  let segs: Seg[] = [];
  labels.forEach((l, i) => {
    const s = segs[segs.length - 1];
    if (s && s.type === l && phrase[s.b] === phrase[i]) s.b = i;
    else segs.push({ type: l, a: i, b: i });
  });
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.b - s.a + 1 >= cfg.minSectionRows) continue;
      const prev = segs[i - 1];
      const next = segs[i + 1];
      const okPrev = prev && phrase[prev.b] === phrase[s.a];
      const okNext = next && phrase[next.a] === phrase[s.b];
      const target = okPrev && okNext ? (prev.b - prev.a >= next.b - next.a ? prev : next) : okPrev ? prev : okNext ? next : null;
      if (!target) continue;
      target.a = Math.min(target.a, s.a);
      target.b = Math.max(target.b, s.b);
      segs.splice(i, 1);
      changed = true;
      break;
    }
    segs = segs.reduce<Seg[]>((acc, s) => {
      const l = acc[acc.length - 1];
      if (l && l.type === s.type && phrase[l.b] === phrase[s.a]) l.b = s.b;
      else acc.push(s);
      return acc;
    }, []);
  }
  // Runs (roll, trill, chord roll) are only recognised at their 3rd/4th row: pull the
  // start of such a section back to the first note of the run.
  const lead: Partial<Record<PatternType, (r: Row) => boolean>> = {
    roll: (r) => r.roll, trill: (r) => r.trill, jumptrill: (r) => r.trill, splittrill: (r) => r.trill,
    brackets: (r) => r.trill, chordroll: (r) => r.chordRoll,
  };
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    const prev = segs[i - 1];
    const flag = lead[s.type];
    if (!flag || phrase[prev.b] !== phrase[s.a]) continue;
    const first = rows.slice(s.a, Math.min(s.b + 1, s.a + 4)).findIndex(flag);
    if (first < 0) continue;
    const back = (s.type === 'chordroll' ? 2 : 3) - first;
    const newA = Math.max(prev.a, s.a - back);
    if (newA >= s.a) continue;
    if (newA - prev.a < cfg.minSectionRows) {
      // what is left of the previous section is just the run's lead-in: absorb it
      s.a = prev.a;
      segs.splice(i - 1, 1);
      i--;
    } else {
      prev.b = newA - 1;
      s.a = newA;
    }
  }
  for (const s of segs) for (let i = s.a; i <= s.b; i++) labels[i] = s.type;

  const sections = segs.map((s) => buildSection(s.type, rows, s.a, s.b, K, cfg));

  // ---- shares
  const byTime: Partial<Record<PatternType, number>> = {};
  const byNotes: Partial<Record<PatternType, number>> = {};
  const byGroup: Partial<Record<SkillGroup, number>> = {};
  const byCore: Partial<Record<CorePattern, number>> = {};
  let totalT = 0;
  for (const s of sections) {
    const nextRow = rows[s.lastRow + 1];
    const tail = nextRow && nextRow.gap <= nextRow.beatLength * cfg.breakBeats ? nextRow.time - rows[s.lastRow].time : 0;
    const dur = Math.max(1, rows[s.lastRow].time - s.start + tail);
    totalT += dur;
    byTime[s.type] = (byTime[s.type] ?? 0) + dur;
    byNotes[s.type] = (byNotes[s.type] ?? 0) + s.notes;
  }
  for (const k of Object.keys(byTime) as PatternType[]) {
    byTime[k]! /= totalT;
    byNotes[k]! /= Math.max(1, map.notes.length);
    const info = PATTERN_INFO[k];
    byGroup[info.group] = (byGroup[info.group] ?? 0) + byTime[k]!;
    byCore[info.core] = (byCore[info.core] ?? 0) + byTime[k]!;
  }
  const dominant = (Object.keys(byTime) as PatternType[]).sort((a, b) => byTime[b]! - byTime[a]!);

  const result: PatternResult = {
    keys: K, rows, labels, sections, byTime, byNotes, byGroup, byCore, dominant, lnRatio, mode,
    category: '', suggestedTags: [],
    stats: chartStats(map), tagScores: {}, slot: 'RC', categories: {},
  };
  result.tagScores = tagScores(result.stats);
  result.slot = ruleSlot(result.stats);
  result.categories = categoryScores(result.stats);
  result.category = categorise(result);
  result.suggestedTags = suggestTags(result);
  return result;
}

function buildSection(type: PatternType, rows: Row[], a: number, b: number, K: number, cfg: PatternConfig): PatternSection {
  const rs = rows.slice(a, b + 1);
  const ns = rs.flatMap((r) => r.notes);
  const start = rs[0].time;
  const end = Math.max(...ns.map((n) => n.endTime ?? n.time));
  const gaps = rs.slice(1).map((r) => r.gap);
  const med = median(gaps);
  const typical = gaps.filter((g) => Math.abs(g - med) <= med * 0.1);
  const mg = typical.length ? typical.reduce((x, y) => x + y, 0) / typical.length : med;

  // jack runs per column
  let minijacks = 0;
  let longestJack = 1;
  for (let c = 0; c < K; c++) {
    let run = 0;
    const flush = () => { if (run === 2) minijacks++; longestJack = Math.max(longestJack, run); run = 0; };
    for (const r of rs) { if (r.mask & (1 << c)) run++; else flush(); }
    flush();
  }
  const counts = new Array(K).fill(0);
  ns.forEach((n) => counts[n.column]++);
  const anchors = K >= 4 && ns.length >= 8 && !['jack', 'longjack', 'trill'].includes(type)
    ? counts.map((c, i) => [c, i]).filter(([c]) => c / ns.length >= cfg.anchorShare).map(([, i]) => i)
    : [];
  const snapped = rs.filter((r) => r.snap > 1);
  const ternary = snapped.filter((r) => r.snap % 3 === 0).length;
  const binary = snapped.length - ternary;
  const unsnapped = rs.filter((r) => r.snap === 0).length;
  const complexSnap = rs.length >= 6 && (Math.min(ternary, binary) / rs.length >= 0.15 || unsnapped / rs.length >= 0.1);
  const trillRows = rs.filter((r) => r.trill || r.abA);
  const tags: SectionTags = {
    minijacks, longestJack, anchors,
    graces: rs.filter((r) => r.grace).length,
    shields: rs.reduce((x, r) => x + r.shields, 0),
    reverseShields: rs.reduce((x, r) => x + r.reverseShields, 0),
    columnLock: rs.filter((r) => r.colLock).length,
    complexSnap,
  };
  if (['trill', 'jumptrill', 'splittrill', 'minitrill'].includes(type) && trillRows.length) {
    tags.hands = trillRows.filter((r) => isOneHand(r.cols, K) && (r.size > 1 || isOneHand([...r.cols, ...(rows[r.index - 1] ?? rows[r.index + 1] ?? r).cols], K))).length / trillRows.length >= 0.5
      ? 'one-hand' : 'two-hand';
  }
  return {
    type, start, end, rows: rs.length, notes: ns.length,
    nps: ns.length / Math.max(0.25, (rs[rs.length - 1].time - start + (Number.isFinite(mg) ? mg : 250)) / 1000),
    speedBpm: Number.isFinite(mg) && mg > 0 ? Math.round(60000 / (mg * 4)) : 0,
    ...speedOf(mg, rs[0].beatLength),
    anchors, jacks: rs.slice(1).filter((r) => r.jack).length, tags,
    firstRow: a, lastRow: b,
  };
}

function speedOf(gap: number, beatLength: number): { rowsPerBeat: number; bpm: number; speed: string } {
  const bpm = Math.round((60000 / beatLength) * 100) / 100;
  if (!Number.isFinite(gap) || gap <= 0) return { rowsPerBeat: 0, bpm, speed: '-' };
  const rpb = beatLength / gap;
  for (const d of SNAPS) if (Math.abs(rpb - d) / d < 0.04) return { rowsPerBeat: d, bpm, speed: `1/${d} @ ${bpm}` };
  if (rpb < 1) {
    const beats = Math.round(1 / rpb);
    if (Math.abs(1 / rpb - beats) < 0.05) return { rowsPerBeat: rpb, bpm, speed: `${beats}/1 @ ${bpm}` };
  }
  return { rowsPerBeat: Math.round(rpb * 100) / 100, bpm, speed: `${Math.round(60000 / (gap * 4))} bpm (1/4)` };
}

// ================================================================ map-level summary

/** Interlude-style category: main pattern (+ "Hybrid" when jacks and streams both matter) (+ "Tech" for complex rhythm). */
function categorise(r: PatternResult): string {
  const top = r.dominant.filter((t) => t !== 'slow');
  if (!top.length) return r.dominant.length ? 'Slow' : 'Uncategorised';
  let name = PATTERN_INFO[top[0]].name;
  if (top[0] === 'jumpstream' && (r.byTime.handstream ?? 0) / (r.byTime.jumpstream ?? 1) > 0.4) name = 'Jumpstream/Handstream';
  if (top[0] === 'handstream' && (r.byTime.jumpstream ?? 0) / (r.byTime.handstream ?? 1) > 0.4) name = 'Handstream/Jumpstream';
  const core1 = PATTERN_INFO[top[0]].core;
  const jacks = r.byCore.Jacks ?? 0;
  const streams = (r.byCore.Stream ?? 0) + (r.byCore.Chordstream ?? 0);
  const rcHybrid = (core1 === 'Jacks' && streams >= 0.25) || (core1 !== 'Jacks' && core1 !== 'LN' && jacks >= 0.25);
  const lnHybrid = r.mode === 'Hybrid';
  const timeTotal = r.sections.reduce((s, x) => s + (x.end - x.start), 0) || 1;
  const tech = r.sections.filter((s) => s.tags.complexSnap).reduce((s, x) => s + (x.end - x.start), 0) / timeTotal >= 0.25;
  return `${name}${rcHybrid || lnHybrid ? ' Hybrid' : ''}${tech ? ' Tech' : ''}`;
}

/**
 * Suggest osu! user tags. The tags with a validated rule (Columnist) decide by score >= 0.5;
 * the section analysis adds evidence to the reason and covers tags the rules do not
 * (tech/complex snap from snaps, style/LN mixed, style/mixed rice, style/tiebreaker).
 */
function suggestTags(r: PatternResult): SuggestedTag[] {
  const out: SuggestedTag[] = [];
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const st = r.stats;
  const evidence: Record<string, string> = {
    'style/jumpstream': `${pct(st.jumpstream_row ?? 0)} of rows are jumps in streams; jumpstream sections ${pct(r.byTime.jumpstream ?? 0)}`,
    'style/handstream': `${pct(st.handstream_row ?? 0)} of rows are 3+ chords in streams; handstream sections ${pct(r.byTime.handstream ?? 0)}`,
    'style/chordstream': `chords in streams ${pct((st.jumpstream_row ?? 0) + (st.handstream_row ?? 0))} of rows`,
    'style/quadstream': `${pct(st.row_quad ?? 0)} of rows are 4+ chords`,
    'style/chordjack': `${pct(st.chordjack_row ?? 0)} of rows are chords jacking chords; chordjack sections ${pct(r.byTime.chordjack ?? 0)}`,
    'skillset/speedjack': `jacks on ${pct(st.jack_row ?? 0)} of rows, median jack gap ${Math.round(st.jack_gap_ms ?? 0)} ms`,
    'style/longjack': `${pct(st.jack_chain3 ?? 0)} of notes are in jack chains of 3+ (longest ${st.jack_longest ?? 0})`,
    'skillset/wristjack': `${pct(st.jack_note ?? 0)} of notes are jacked`,
    'skillset/streams': `${pct(st.stream_row ?? 0)} of rows are fast without jacks`,
    'streams/speed': `${(st.nps_per_key ?? 0).toFixed(1)} notes/s per key`,
    'streams/stamina': `dense for about ${Math.round((st.stamina ?? 0) * (st.duration_s ?? 0))} s`,
    'skillset/tech': `rhythm variety ${(st.rhythm_variety ?? 0).toFixed(1)}, gap changes ${pct(st.gap_ratio_change ?? 0)}`,
    'style/LN density': `${(st.ln_count_ps ?? 0).toFixed(1)} LNs/s`,
    'style/LN release': `${pct(st.ln_release_offgrid ?? 0)} of releases land between notes`,
    'style/LN coordination': `on average ${((st.ln_held_mean ?? 0) * r.keys).toFixed(1)} columns held per note`,
    'gimmick/LN inverse': `${pct(st.ln_inverse ?? 0)} of LNs end right before the next note`,
    'style/generic hybrid': `${pct(r.lnRatio)} LN`,
    'sliders/complex sv': `${(st.sv_changes_near_notes_ps ?? 0).toFixed(2)} SV changes/s near notes`,
    'sliders/low sv': `${pct(st.sv_stop_frac ?? 0)} of the time almost stopped`,
    'sliders/high sv': `${pct(st.sv_fast_frac ?? 0)} of the time at 2x+ speed`,
  };
  // jumpstream / handstream / quadstream are 4K terms (osu! wiki); other key counts call all of it chordstream
  const fourKOnly = new Set(['style/jumpstream', 'style/handstream', 'style/quadstream']);
  for (const [tag, score] of Object.entries(r.tagScores).sort((a, b) => b[1] - a[1])) {
    if (score < 0.5) continue;
    if (r.keys !== 4 && fourKOnly.has(tag)) continue;
    out.push({ tag, score: Math.round(score * 100) / 100, reason: evidence[tag] ?? '' });
  }
  if (r.keys !== 4 && !out.some((t) => t.tag === 'style/chordstream')) {
    const cs = Math.max(...[...fourKOnly].map((t) => r.tagScores[t] ?? 0));
    if (cs >= 0.5) out.push({ tag: 'style/chordstream', score: Math.round(cs * 100) / 100, reason: `chords in streams (${r.keys}K)` });
  }
  const has = (t: PatternType, min: number) => (r.byTime[t] ?? 0) >= min;
  const timeTotal = r.sections.reduce((x, y) => x + (y.end - y.start), 0) || 1;
  const tech = r.sections.filter((x) => x.tags.complexSnap).reduce((x, y) => x + (y.end - y.start), 0) / timeTotal;
  if (tech >= 0.2) out.push({ tag: 'tech/complex snap', reason: `mixed 1/3- and 1/4-family snaps in ${pct(tech)} of the map` });
  const lnTypes = (['inverse', 'lncoordination', 'lnrelease', 'lndensity'] as PatternType[]).filter((t) => has(t, 0.12));
  if (lnTypes.length >= 2) out.push({ tag: 'style/LN mixed', reason: `several LN styles: ${lnTypes.map((t) => PATTERN_INFO[t].name).join(', ')}` });
  // Columnist found the mixed-rice user tag too noisy to learn and derives it: skills from 2+ of jacks / streams / tech
  const sk = r.tagScores;
  const fam = [
    Math.max(sk['style/chordjack'] ?? 0, sk['skillset/speedjack'] ?? 0, sk['style/longjack'] ?? 0),
    Math.max(sk['skillset/streams'] ?? 0, sk['style/jumpstream'] ?? 0, sk['style/handstream'] ?? 0),
    sk['skillset/tech'] ?? 0,
  ].filter((v) => v >= 0.5).length;
  if (fam >= 2 && r.mode !== 'LN') out.push({ tag: 'style/mixed rice', reason: 'skills from two or more of jacks / streams / tech' });
  if (r.mode === 'Hybrid' && (sk['skillset/tech'] ?? 0) >= 0.5) out.push({ tag: 'tech/technical hybrid', reason: `rice + LN (${pct(r.lnRatio)} LN) with technical rhythm` });
  if ((r.categories.TB ?? 0) >= 0.5) out.push({ tag: 'style/tiebreaker', reason: `${Math.round((st.duration_s ?? 0) / 60)} min at ${(st.nps ?? 0).toFixed(1)} notes/s` });
  return out;
}

// ================================================================ helpers

export function notesOfType(result: PatternResult, types: PatternType | PatternType[]): Note[] {
  const want = new Set(Array.isArray(types) ? types : [types]);
  return result.rows.filter((_, i) => want.has(result.labels[i])).flatMap((r) => r.notes);
}

export function summarize(result: PatternResult, top = 4): string {
  return result.dominant.slice(0, top)
    .map((t) => `${PATTERN_INFO[t].name} ${Math.round((result.byTime[t] ?? 0) * 100)}%`)
    .join(' · ');
}

/** Short human list of a section's tags, e.g. "anchor col 1 · 3 minijacks · one-hand". */
export function describeTags(s: PatternSection): string {
  const t = s.tags;
  const parts: string[] = [];
  if (t.hands) parts.push(t.hands);
  if (t.anchors.length) parts.push(`anchor col ${t.anchors.map((c) => c + 1).join(',')}`);
  if (t.minijacks && !['jack', 'longjack', 'chordjack', 'quadstream'].includes(s.type) && PATTERN_INFO[s.type].core !== 'LN') parts.push(`${t.minijacks} minijacks`);
  if (s.type === 'longjack' || (s.type === 'jack' && t.longestJack >= 3)) parts.push(`longest jack ${t.longestJack}`);
  if (t.graces) parts.push(`${t.graces} grace/flam`);
  if (t.shields) parts.push(`${t.shields} shields`);
  if (t.reverseShields) parts.push(`${t.reverseShields} reverse shields`);
  if (t.columnLock) parts.push(`column lock ×${t.columnLock}`);
  if (t.complexSnap) parts.push('complex snap');
  return parts.join(' · ');
}
