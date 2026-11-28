/**
 * Pattern engine: turns a planned rhythm (row times + chord sizes) into columns the way mappers
 * think about it, in patterns, not note by note.
 *
 *   - every beat gets a pattern family that fits its rhythm (fast singles: roll / trill / stream;
 *     fast chords: jumpstream, jumptrill, split trill, brackets, chord roll, chordjack; slower rows:
 *     anchored chords, free placement following the pitch). A family usually continues into the
 *     next beat, so sections read as one idea.
 *   - a rhythm that repeats within 8 beats usually gets the same (or mirrored) shape again
 *   - hands stay balanced; no fast jacks (<= 1/4 beat or 90 ms) unless the style is about jacks
 *   - the style sets the family weights, how big chords get, how much jacking is allowed and how
 *     much repetition there is
 */
import type { LnPreset } from '../tools/lnconvert';
import { handOf } from '../analysis/patterns';


/**
 * Scales each style's chance of replaying a shape for a repeated rhythm (benchmarks only). Tried 0.3:
 * charts then repeat shapes as often as ranked maps (held-out 7K 0.119 vs 0.127, from 0.25), but the
 * pattern mix moved away from the ranked maps on most 7K songs (6+ stars: 43 worse, 15 better), so 1 stays.
 */
let REPEAT_SCALE = 1;
export function _setRepeatScale(v: number) { REPEAT_SCALE = v; }

export type Style = 'balanced' | 'stream' | 'jumpstream' | 'chordjack' | 'tech' | 'ln';

export type Family =
  | 'roll' | 'trill' | 'minitrill' | 'stream'
  | 'jumpstream' | 'jumptrill' | 'splittrill' | 'bracket' | 'chordroll' | 'chordjack'
  | 'anchor' | 'free';

type Weights = Partial<Record<Family, number>>;

export interface StyleDef {
  label: string;
  description: string;
  /** multiplies the chord sizes the rhythm stage asks for */
  chordScale: number;
  /** most rows get at least this many notes (chordjack: 2) */
  minChord?: number;
  /** 0..1: chance that beat / half-beat rows inside fast runs become chords (jumpstream feel) */
  fastChords: number;
  /** shortest allowed same-column gap in beats (fast jacks are always <= 1/4 beat) */
  minJackBeats: number;
  /** weights per rhythm class */
  fastSingle: Weights;
  fastChord: Weights;
  medium: Weights;
  /** chance that a repeated rhythm gets the same shape */
  repeat: number;
  /** extra stream fill (0..1) on top of the intensity the difficulty search picks */
  fill: number;
  /** LN conversion applied after placement */
  ln?: LnPreset;
}

export const STYLES: Record<Style, StyleDef> = {
  balanced: {
    label: 'Balanced', description: 'A bit of everything, following the music',
    chordScale: 1, fastChords: 0.25, minJackBeats: 0.5,
    fastSingle: { roll: 2, trill: 1, minitrill: 1, stream: 3 },
    fastChord: { jumpstream: 4, jumptrill: 1, splittrill: 0.7, bracket: 1, chordroll: 1 },
    medium: { stream: 2, roll: 1, jumptrill: 1, anchor: 1, chordjack: 3, free: 2 },
    repeat: 0.35, fill: 0,
  },
  stream: {
    label: 'Stream', description: 'Rolls, trills and runs of single notes',
    chordScale: 0.5, fastChords: 0.05, minJackBeats: 0.5,
    fastSingle: { roll: 3, trill: 2, minitrill: 1, stream: 4 },
    fastChord: { jumpstream: 3, chordroll: 1 },
    medium: { stream: 3, roll: 2, trill: 1, free: 1 },
    repeat: 0.5, fill: 0.35,
  },
  jumpstream: {
    label: 'Jumpstream', description: 'Streams with chords on the beats',
    chordScale: 1.1, fastChords: 0.75, minJackBeats: 0.5,
    fastSingle: { stream: 3, roll: 1 },
    fastChord: { jumpstream: 6, jumptrill: 1, bracket: 1 },
    medium: { jumpstream: 2, stream: 2, free: 1 },
    repeat: 0.45, fill: 0.3,
  },
  chordjack: {
    label: 'Chordjack', description: 'Big chords that share columns: jacks are the point',
    chordScale: 1.6, minChord: 2, fastChords: 0.6, minJackBeats: 0.25,
    fastSingle: { stream: 2, minitrill: 1 },
    fastChord: { chordjack: 6, jumpstream: 1 },
    medium: { chordjack: 4, anchor: 2, free: 1 },
    repeat: 0.4, fill: 0.15,
  },
  tech: {
    label: 'Technical', description: 'Split trills, brackets, rolls and anchors',
    chordScale: 1, fastChords: 0.35, minJackBeats: 0.5,
    fastSingle: { roll: 2, minitrill: 3, trill: 1, stream: 1 },
    fastChord: { splittrill: 3, bracket: 2, chordroll: 2, jumptrill: 1, jumpstream: 1 },
    medium: { anchor: 3, splittrill: 1, roll: 1, free: 1 },
    repeat: 0.35, fill: 0.1,
  },
  ln: {
    label: 'Long notes', description: 'Holds on sustained sounds with clean releases',
    chordScale: 0.9, fastChords: 0.2, minJackBeats: 0.5,
    fastSingle: { roll: 2, stream: 3, trill: 1 },
    fastChord: { jumpstream: 3, chordroll: 1 },
    medium: { free: 3, stream: 1, anchor: 1 },
    repeat: 0.5, fill: 0, ln: 'hybrid',
  },
};

export interface PlannedRow {
  t: number;
  size: number;
  /** 0..1 pitch centroid (low = left) */
  centroid: number;
  /** position in the beat, 0 = on the beat */
  beatFrac: number;
  beatIndex: number;
  /** style of this row's section (auto style); falls back to PlaceOptions.style */
  style?: StyleDef;
}

export interface PlaceOptions {
  keys: number;
  beatLen: number;
  style: StyleDef;
  /** 0..1 how strongly pitch decides the column in free placement */
  pitchFollow: number;
  rand: () => number;
  /** override the shortest same-column gap in ms */
  minJackGap?: number;
  /**
   * 0..1 sound direction: rows whose lane target (centroid) is clearly left or right go to that
   * hand, even if that leaves the hands unbalanced for a while (stereo direction uses 1)
   */
  lean?: number;
}

interface FamilyState {
  family: Family;
  pos: number;
  dir: number;
  pair: [number[], number[]];
  flip: boolean;
  anchor: number;
  rows: number;
}

/** Place every row; returns the chosen columns per row (same order as `rows`). */
export function placeColumns(rows: PlannedRow[], o: PlaceOptions): number[][] {
  const K = o.keys;
  const { beatLen, rand, style } = o;
  // never a fast jack (<= 1/4 beat or 90 ms) ...
  const minGap = o.minJackGap ?? Math.max(beatLen / 2 - 3, beatLen / 4 + 3, 91);
  // ... except where a jack family (chordjack) asks for one and the style allows it
  const jackGapOf = (st: StyleDef) => Math.min(minGap, Math.max(60, beatLen * st.minJackBeats - 3));
  let jackGap = jackGapOf(style);
  const lastHit = new Array<number>(K).fill(-Infinity);
  const useCount = new Array<number>(K).fill(0);
  const handRecent = [0, 0];
  const out: number[][] = [];
  const history = new Map<string, { beat: number; shapes: number[][] }>();
  let state: FamilyState | null = null;
  let lastStyle: StyleDef | null = null;
  let prev: number[] = [];
  let prevT = -Infinity;

  const leftCols = [...Array(K).keys()].filter((c) => handOf(c, K) === 0);
  const rightCols = [...Array(K).keys()].filter((c) => handOf(c, K) === 1);

  const allowed = (c: number, t: number, jackOk: boolean) => t - lastHit[c] >= (jackOk ? jackGap : minGap) - 0.5;

  /** how strongly this row leans to one hand (0 = no lean) */
  const leanOf = (row: PlannedRow) => (o.lean ?? 0) * Math.max(0, Math.min(1, (Math.abs(row.centroid - 0.5) - 0.1) / 0.25));
  /** general desirability of column c for this row (higher is better) */
  const score = (c: number, row: PlannedRow, picked: number[]) => {
    let s = 0;
    const lean = leanOf(row);
    const total = useCount.reduce((x, y) => x + y, 0) + K;
    s -= ((useCount[c] + 1) / total - 1 / K) * K * 1.5 * (1 - 0.7 * lean); // column balance
    const h = handOf(c, K);
    if (h !== -1) {
      const hr = handRecent[h] / Math.max(1, handRecent[0] + handRecent[1]);
      s -= (hr - 0.5) * 2 * (1 - lean); // hand balance (sound direction may override it)
      const sameHand = picked.filter((p) => handOf(p, K) === h).length;
      if (sameHand >= Math.ceil(row.size / 2)) s -= 3 * (1 - lean); // split chords over both hands
    }
    if (prev.includes(c)) s -= 1.2; // moving is nicer than repeating
    s -= (o.pitchFollow + 3 * lean) * Math.abs(c - row.centroid * (K - 1)) / Math.max(1, K - 1) * 1.5;
    if (picked.some((p) => Math.abs(p - c) === 1) && K > 5) s -= 0.4; // spread chords on many keys
    s -= Math.min(4, (row.t - lastHit[c]) < beatLen ? (beatLen - (row.t - lastHit[c])) / beatLen : 0); // recently used
    return s + rand() * 0.6;
  };

  const pick = (row: PlannedRow, preferred: number[], jackOk: boolean): number[] => {
    const picked: number[] = [];
    // a clear lean: the pattern's columns on the other hand give way to the score
    if (leanOf(row) >= 0.5) {
      const side = row.centroid < 0.5 ? 0 : 1;
      preferred = preferred.filter((c) => handOf(c, K) !== 1 - side);
    }
    for (const c of preferred) {
      if (picked.length >= row.size) break;
      if (c < 0 || c >= K || picked.includes(c) || !allowed(c, row.t, jackOk)) continue;
      picked.push(c);
    }
    while (picked.length < row.size) {
      let best = -1, bs = -Infinity;
      for (let c = 0; c < K; c++) {
        if (picked.includes(c) || !allowed(c, row.t, false)) continue;
        const s = score(c, row, picked);
        if (s > bs) { bs = s; best = c; }
      }
      if (best < 0) break;
      picked.push(best);
    }
    return picked.sort((a, b) => a - b);
  };

  const weighted = (w: Weights): Family => {
    const entries = (Object.entries(w) as [Family, number][]).filter(([f]) => K >= minKeys(f));
    const sum = entries.reduce((s, [, v]) => s + v, 0);
    let r = rand() * sum;
    for (const [f, v] of entries) { r -= v; if (r <= 0) return f; }
    return entries[0]?.[0] ?? 'free';
  };

  const newState = (family: Family, size: number): FamilyState => {
    const st: FamilyState = { family, pos: Math.floor(rand() * K), dir: rand() < 0.5 ? 1 : -1, pair: [[], []], flip: false, anchor: Math.floor(rand() * K), rows: 0 };
    const sz = Math.max(1, Math.min(Math.floor(K / 2) || 1, size));
    if (family === 'trill' || family === 'minitrill') {
      // a pair on different hands (trill) or neighbours on one hand (minitrill)
      if (family === 'trill' && leftCols.length && rightCols.length) {
        st.pair = [[leftCols[Math.floor(rand() * leftCols.length)]], [rightCols[Math.floor(rand() * rightCols.length)]]];
      } else {
        const a = Math.floor(rand() * Math.max(1, K - 1));
        st.pair = [[a], [Math.min(K - 1, a + 1)]];
      }
    } else if (family === 'jumptrill') {
      const cols = shuffle([...Array(K).keys()], rand);
      const a = cols.slice(0, sz).sort((x, y) => x - y);
      const b = cols.filter((c) => !a.includes(c)).slice(0, sz).sort((x, y) => x - y);
      // classic jumptrill: one hand-pair against the other
      if (K === 4) { st.pair = rand() < 0.5 ? [[0, 1], [2, 3]] : [[0, 2], [1, 3]]; } else st.pair = [a, b];
    } else if (family === 'splittrill') {
      // outer pair against the pair inside it (4K: [1,4] / [2,3]); shifted inwards sometimes on many keys
      const d = K >= 6 && rand() < 0.5 ? 1 : 0;
      st.pair = [[d, K - 1 - d], [d + 1, K - 2 - d]];
    } else if (family === 'bracket') {
      st.pair = [[...Array(K).keys()].filter((c) => c % 2 === 0), [...Array(K).keys()].filter((c) => c % 2 === 1)];
    }
    return st;
  };

  const preferredFor = (st: FamilyState, row: PlannedRow): { cols: number[]; jackOk: boolean } => {
    st.rows++;
    switch (st.family) {
      case 'roll': case 'chordroll': {
        let p = st.pos + st.dir;
        if (p < 0 || p >= K) { st.dir = -st.dir; p = st.pos + st.dir; }
        st.pos = Math.max(0, Math.min(K - 1, p));
        const cols = [st.pos];
        for (let i = 1; i < row.size; i++) cols.push(st.pos + i * 2 * (st.dir > 0 ? -1 : 1));
        return { cols, jackOk: false };
      }
      case 'trill': case 'minitrill': case 'jumptrill': case 'splittrill': case 'bracket': {
        if (st.family === 'minitrill' && st.rows % 4 === 0) { st.pair = [st.pair[0].map((c) => clamp(c + st.dir, K)), st.pair[1].map((c) => clamp(c + st.dir, K))]; if (st.pair[0][0] === st.pair[1][0]) st.dir = -st.dir; }
        st.flip = !st.flip;
        const side = st.flip ? st.pair[0] : st.pair[1];
        return { cols: shuffle([...side], rand), jackOk: false };
      }
      case 'chordjack': {
        // keep part of the previous chord (the jack), move the rest
        // (single notes do not jack: that would be jackspeed, not chordjack)
        const keep = prev.length && row.size > 1 ? Math.max(1, Math.min(prev.length, row.size - 1 - (rand() < 0.3 ? 1 : 0))) : 0;
        const kept = shuffle([...prev], rand).slice(0, keep);
        return { cols: [...kept, ...shuffle([...Array(K).keys()].filter((c) => !kept.includes(c)), rand)], jackOk: true };
      }
      case 'anchor': {
        // one column on every other row, the others move around it
        const useAnchor = st.rows % 2 === 1;
        return { cols: useAnchor ? [st.anchor] : [], jackOk: false };
      }
      case 'stream': case 'jumpstream': {
        // least recently used columns, other hand first
        const lastHand = prev.length ? handOf(prev[0], K) : -1;
        const order = [...Array(K).keys()].filter((c) => !prev.includes(c))
          .sort((a, b) => (lastHit[a] - lastHit[b]) + (handOf(a, K) === lastHand ? 40 : 0) - (handOf(b, K) === lastHand ? 40 : 0) + (rand() - 0.5) * 30);
        return { cols: order, jackOk: false };
      }
      default:
        return { cols: [], jackOk: false };
    }
  };

  // group rows per beat
  let i = 0;
  while (i < rows.length) {
    const beat = rows[i].beatIndex;
    let j = i;
    while (j < rows.length && rows[j].beatIndex === beat) j++;
    const group = rows.slice(i, j);
    const gaps = group.map((r, k) => (k ? r.t - group[k - 1].t : r.t - prevT));
    const pace = Math.min(...gaps.filter((g) => g > 0), Infinity);
    const chords = group.some((r) => r.size > 1);
    const cls: 'fastSingle' | 'fastChord' | 'medium' | 'slow' = pace <= beatLen / 3 + 2 ? (chords ? 'fastChord' : 'fastSingle') : pace <= beatLen / 2 + 2 ? 'medium' : 'slow';

    // repeated rhythm -> repeated (or mirrored) shape
    const sig = `${group.length}:` + group.map((r) => `${Math.round((r.beatFrac) * 48)}/${r.size}`).join(',');
    const seen = history.get(sig);
    const gs = group[0].style ?? style;
    jackGap = jackGapOf(gs);
    const replay = seen && beat - seen.beat <= 8 && rand() < gs.repeat * REPEAT_SCALE ? seen.shapes : null;
    const mirror = replay && rand() < 0.4;

    if (cls === 'slow') state = null;
    else if (!state || rand() > 0.6 || !fits(state.family, cls) || gs !== lastStyle) {
      const w = gs[cls];
      state = newState(weighted(w), Math.max(...group.map((r) => r.size)));
    }

    const shapes: number[][] = [];
    group.forEach((row, k) => {
      let cols: number[] | null = null;
      if (replay && replay[k]) {
        let want = mirror ? replay[k].map((c) => K - 1 - c) : replay[k];
        // sound direction: replay the shape on the side the sound comes from (mirrored if needed)
        if (leanOf(row) >= 0.5) {
          const side = (cs: number[]) => cs.reduce((x, c) => x + c, 0) / cs.length / Math.max(1, K - 1);
          const flipped = want.map((c) => K - 1 - c);
          if (Math.abs(side(flipped) - row.centroid) < Math.abs(side(want) - row.centroid)) want = flipped;
        }
        if (want.length === row.size && want.every((c) => allowed(c, row.t, state?.family === 'chordjack'))) cols = [...want].sort((a, b) => a - b);
      }
      if (!cols) {
        const pref = state ? preferredFor(state, row) : { cols: [], jackOk: false };
        cols = pick(row, pref.cols, pref.jackOk);
      }
      for (const c of cols) {
        lastHit[c] = row.t;
        useCount[c]++;
        const h = handOf(c, K);
        if (h !== -1) handRecent[h]++;
      }
      // forget old hand history slowly
      handRecent[0] *= 0.97; handRecent[1] *= 0.97;
      prev = cols;
      prevT = row.t;
      shapes.push(cols);
      out.push(cols);
    });
    history.set(sig, { beat, shapes });
    lastStyle = gs;
    i = j;
  }
  return out;
}

function minKeys(f: Family): number {
  switch (f) {
    case 'trill': case 'minitrill': case 'roll': return 2;
    case 'jumptrill': case 'splittrill': return 4;
    case 'bracket': return 5;
    case 'chordroll': return 5;
    default: return 1;
  }
}

function fits(f: Family, cls: string): boolean {
  if (cls === 'fastSingle') return ['roll', 'trill', 'minitrill', 'stream'].includes(f);
  if (cls === 'fastChord') return !['trill', 'minitrill', 'roll', 'free', 'anchor'].includes(f);
  return true;
}

const clamp = (c: number, K: number) => Math.max(0, Math.min(K - 1, c));

function shuffle<T>(a: T[], rand: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
