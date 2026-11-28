/**
 * Map transforms. Every function takes a Beatmap and returns a NEW Beatmap
 * (input is never mutated), so the editor can push results on its undo stack.
 */
import {
  type Beatmap, type Note, cloneBeatmap, getKeys, setKeys, isLN, sortNotes,
} from '../core/beatmap';
import { redLineAt, snapTime } from '../core/timing';
import { rng, shuffleInPlace } from '../core/rng';
import { convertKeysSmart, type SmartConvertOptions } from './keyconvert';

/** Notes grouped by (rounded) start time = chords. */
export function chords(notes: Note[], tolerance = 1): Note[][] {
  const sorted = sortNotes([...notes]);
  const out: Note[][] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0].time - n.time) <= tolerance) last.push(n);
    else out.push([n]);
  }
  return out;
}

/** Tracks when each column becomes free again (respects LNs). */
class ColumnState {
  busyUntil: number[];
  lastTime: number[];
  constructor(keys: number, public minGap = 1) {
    this.busyUntil = new Array(keys).fill(-Infinity);
    this.lastTime = new Array(keys).fill(-Infinity);
  }
  free(col: number, time: number): boolean {
    return time >= this.busyUntil[col] + this.minGap;
  }
  occupy(col: number, n: Note) {
    this.busyUntil[col] = isLN(n) ? n.endTime! : n.time;
    this.lastTime[col] = n.time;
  }
}

// ---------------------------------------------------------------- simple column ops

export function mirror(map: Beatmap): Beatmap {
  const out = cloneBeatmap(map);
  const k = getKeys(out);
  for (const n of out.notes) n.column = k - 1 - n.column;
  sortNotes(out.notes);
  return out;
}

/** Swap whole columns with a random permutation (patterns keep their shape per column). */
export function permuteColumns(map: Beatmap, seed = Date.now()): Beatmap {
  const out = cloneBeatmap(map);
  const k = getKeys(out);
  const perm = shuffleInPlace([...Array(k).keys()], rng(seed));
  for (const n of out.notes) n.column = perm[n.column];
  sortNotes(out.notes);
  return out;
}

/**
 * Re-roll every chord into random columns (keeps rhythm + chord sizes, LN lengths).
 * `avoidJacks` tries not to reuse a column that was hit in the previous chord.
 */
export function randomize(map: Beatmap, seed = Date.now(), avoidJacks = true): Beatmap {
  const out = cloneBeatmap(map);
  const k = getKeys(out);
  const rand = rng(seed);
  const st = new ColumnState(k);
  const result: Note[] = [];
  let prevCols = new Set<number>();
  for (const chord of chords(out.notes)) {
    const t = chord[0].time;
    const free = [...Array(k).keys()].filter((c) => st.free(c, t));
    shuffleInPlace(free, rand);
    if (avoidJacks) free.sort((a, b) => Number(prevCols.has(a)) - Number(prevCols.has(b)));
    const used = new Set<number>();
    chord.forEach((n, i) => {
      if (i >= free.length) return; // no space: drop
      n.column = free[i];
      used.add(n.column);
      st.occupy(n.column, n);
      result.push(n);
    });
    prevCols = used;
  }
  out.notes = sortNotes(result);
  return out;
}

// ---------------------------------------------------------------- key conversion

export interface ConvertOptions {
  seed?: number;
  /** keep jacks (same source column twice in a row stays the same target column). default true */
  keepJacks?: boolean;
}

/**
 * Convert between any key counts (1..18), e.g. 4K -> 7K or 10K -> 6K.
 *
 * Each source column owns a band of target columns. Up-conversion (N < M): notes
 * in a source column alternate within the band, so you get spread-out patterns
 * instead of empty columns; jacks stay jacks. Down-conversion (N > M): bands
 * overlap, so collisions are resolved by moving to the nearest free column;
 * if a chord is wider than M or no column is free, the note is dropped.
 */
export function convertKeys(map: Beatmap, targetKeys: number, opts: ConvertOptions & SmartConvertOptions = {}): Beatmap {
  return convertKeysSmart(map, targetKeys, opts);
}

/** The first, simple band-based converter (kept for comparison; it can create fast jacks). */
export function convertKeysSimple(map: Beatmap, targetKeys: number, opts: ConvertOptions = {}): Beatmap {
  const out = cloneBeatmap(map);
  const N = getKeys(out);
  const M = targetKeys;
  setKeys(out, M);
  if (N === M) return out;
  const rand = rng(opts.seed ?? 1);
  const keepJacks = opts.keepJacks ?? true;

  const band = (c: number): number[] => {
    const lo = Math.floor((c * M) / N);
    const hi = Math.max(lo, Math.ceil(((c + 1) * M) / N) - 1);
    const cols: number[] = [];
    for (let i = lo; i <= Math.min(hi, M - 1); i++) cols.push(i);
    return cols;
  };

  const st = new ColumnState(M);
  const lastTargetOfSource = new Array<number>(N).fill(-1);
  const lastSourceTime = new Array<number>(N).fill(-Infinity);
  const prevChordSources = new Set<number>();
  const result: Note[] = [];

  for (const chord of chords(out.notes)) {
    const t = chord[0].time;
    const usedNow = new Set<number>();
    const thisSources = new Set<number>();
    // place notes in order of source column for stable output
    chord.sort((a, b) => a.column - b.column);
    for (const n of chord) {
      const src = n.column;
      thisSources.add(src);
      const isJack = prevChordSources.has(src);
      const b = band(src);
      let candidates: number[];
      if (keepJacks && isJack && lastTargetOfSource[src] >= 0) {
        candidates = [lastTargetOfSource[src], ...b];
      } else {
        // rotate inside the band: avoid the previous target of this source column
        const rot = shuffleInPlace([...b], rand);
        rot.sort((x, y) => Number(x === lastTargetOfSource[src]) - Number(y === lastTargetOfSource[src]));
        candidates = rot;
      }
      // fall back to every other column by distance to band centre
      const centre = (b[0] + b[b.length - 1]) / 2;
      const rest = [...Array(M).keys()]
        .filter((c) => !candidates.includes(c))
        .sort((x, y) => Math.abs(x - centre) - Math.abs(y - centre));
      const pick = [...candidates, ...rest].find((c) => !usedNow.has(c) && st.free(c, t));
      if (pick === undefined) continue; // dropped
      n.column = pick;
      usedNow.add(pick);
      st.occupy(pick, n);
      lastTargetOfSource[src] = pick;
      lastSourceTime[src] = t;
      result.push(n);
    }
    prevChordSources.clear();
    thisSources.forEach((s) => prevChordSources.add(s));
  }
  out.notes = sortNotes(result);
  const v = out.metadata.get('Version');
  if (v !== undefined) {
    out.metadata.set('Version', /\b\d+K\b/i.test(v) ? v.replace(/\b\d+K\b/i, `${M}K`) : `${v} (${M}K)`);
  }
  return out;
}

// ---------------------------------------------------------------- LN tools

export interface LNOptions {
  /** gap before the next note in the same column, in beats (default 1/4 beat) */
  gapBeats?: number;
  /** minimum LN length in ms; shorter ones become normal notes (default 30) */
  minLength?: number;
  /** maximum LN length in beats (0 = unlimited, default 0) */
  maxBeats?: number;
}

/** Every note becomes an LN that holds until shortly before the next note in its column. */
export function fullLN(map: Beatmap, opts: LNOptions = {}): Beatmap {
  return lnByColumn(map, opts, (n, next, gap, maxLen) => {
    if (next === undefined) return n.time + Math.min(maxLen, gap * 4);
    return Math.min(next - gap, n.time + maxLen);
  });
}

/**
 * Inverse: the gaps between notes become LNs and the notes become gaps.
 * Each LN starts at a note and ends one gap before the following note.
 * (Same as full LN; the visual "inverse" style comes from small gaps.)
 */
export function inverseLN(map: Beatmap, opts: LNOptions = {}): Beatmap {
  return fullLN(map, { gapBeats: 1 / 8, ...opts });
}

function lnByColumn(
  map: Beatmap,
  opts: LNOptions,
  endFor: (n: Note, nextTime: number | undefined, gapMs: number, maxLenMs: number) => number,
): Beatmap {
  const out = cloneBeatmap(map);
  const k = getKeys(out);
  const minLength = opts.minLength ?? 30;
  const byCol: Note[][] = Array.from({ length: k }, () => []);
  for (const n of sortNotes(out.notes)) byCol[n.column].push(n);
  for (const col of byCol) {
    for (let i = 0; i < col.length; i++) {
      const n = col[i];
      const beat = redLineAt(out, n.time)?.beatLength ?? 500;
      const gap = beat * (opts.gapBeats ?? 0.25);
      const maxLen = opts.maxBeats ? beat * opts.maxBeats : Infinity;
      const end = Math.round(endFor(n, col[i + 1]?.time, gap, maxLen));
      n.endTime = end - n.time >= minLength ? end : undefined;
    }
  }
  return out;
}

/** Turn all LNs into normal notes. */
export function removeLNs(map: Beatmap): Beatmap {
  const out = cloneBeatmap(map);
  for (const n of out.notes) n.endTime = undefined;
  return out;
}

// ---------------------------------------------------------------- timing ops

/** Snap starts and LN ends to the 1/divisor grid. Duplicates created by snapping are removed. */
export function quantize(map: Beatmap, divisor = 4): Beatmap {
  const out = cloneBeatmap(map);
  const seen = new Set<string>();
  const result: Note[] = [];
  for (const n of sortNotes(out.notes)) {
    n.time = snapTime(out, n.time, divisor);
    if (n.endTime !== undefined) {
      n.endTime = snapTime(out, n.endTime, divisor);
      if (n.endTime <= n.time) n.endTime = undefined;
    }
    const key = `${n.column}@${n.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(n);
  }
  out.notes = result;
  return out;
}

/**
 * Scale the chart for a different playback rate (e.g. 1.2 = 20% faster).
 * Only the chart is changed: the audio must be re-encoded too
 * (the CLI does that with ffmpeg's atempo filter).
 */
export function changeRate(map: Beatmap, rate: number): Beatmap {
  if (!(rate > 0)) throw new Error('rate must be > 0');
  const out = cloneBeatmap(map);
  const s = (t: number) => Math.round(t / rate);
  for (const n of out.notes) {
    n.time = s(n.time);
    if (n.endTime !== undefined) n.endTime = s(n.endTime);
  }
  for (const t of out.timingPoints) {
    t.time = s(t.time);
    if (t.uninherited) t.beatLength /= rate;
  }
  const pt = Number(out.general.get('PreviewTime') ?? -1);
  if (pt > 0) out.general.set('PreviewTime', String(s(pt)));
  const v = out.metadata.get('Version') ?? '';
  out.metadata.set('Version', `${v} ${rate}x`.trim());
  return out;
}

// ---------------------------------------------------------------- validation

export interface Issue {
  time: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
}

export function validate(map: Beatmap): Issue[] {
  const k = getKeys(map);
  const issues: Issue[] = [];
  const reds = map.timingPoints.filter((t) => t.uninherited);
  if (!reds.length) issues.push({ time: 0, severity: 'error', message: 'No uninherited (red) timing point.' });
  const firstRed = reds[0]?.time ?? 0;
  const byCol: Note[][] = Array.from({ length: k }, () => []);
  for (const n of sortNotes([...map.notes])) {
    if (n.column < 0 || n.column >= k) {
      issues.push({ time: n.time, column: n.column, severity: 'error', message: 'Column out of range.' });
      continue;
    }
    byCol[n.column].push(n);
    if (n.time < firstRed) issues.push({ time: n.time, column: n.column, severity: 'warning', message: 'Note before the first timing point.' });
    if (n.endTime !== undefined && n.endTime <= n.time) issues.push({ time: n.time, column: n.column, severity: 'error', message: 'LN ends before it starts.' });
    if (reds.length) {
      const ok = [1, 2, 3, 4, 6, 8, 12, 16].some((d) => Math.abs(snapTime(map, n.time, d) - n.time) <= 1);
      if (!ok) issues.push({ time: n.time, column: n.column, severity: 'warning', message: 'Unsnapped note (not on 1/16 or 1/12).' });
      if (n.endTime !== undefined) {
        const okEnd = [1, 2, 3, 4, 6, 8, 12, 16].some((d) => Math.abs(snapTime(map, n.endTime!, d) - n.endTime!) <= 1);
        if (!okEnd) issues.push({ time: n.endTime, column: n.column, severity: 'warning', message: 'Unsnapped LN end.' });
      }
    }
  }
  for (let c = 0; c < k; c++) {
    const col = byCol[c];
    for (let i = 1; i < col.length; i++) {
      const prev = col[i - 1];
      const cur = col[i];
      const prevEnd = isLN(prev) ? prev.endTime! : prev.time;
      if (cur.time === prev.time) issues.push({ time: cur.time, column: c, severity: 'error', message: 'Stacked notes (same time, same column).' });
      else if (cur.time <= prevEnd) issues.push({ time: cur.time, column: c, severity: 'error', message: 'Note overlaps a long note.' });
    }
  }
  return issues.sort((a, b) => a.time - b.time);
}

/** Remove stacked / overlapping notes (keeps the earlier one). */
export function fixOverlaps(map: Beatmap): Beatmap {
  const out = cloneBeatmap(map);
  const st = new ColumnState(getKeys(out));
  out.notes = sortNotes(out.notes).filter((n) => {
    if (n.column < 0 || n.column >= st.busyUntil.length) return false;
    if (st.lastTime[n.column] === n.time || !st.free(n.column, n.time)) return false;
    st.occupy(n.column, n);
    return true;
  });
  return out;
}

/**
 * Break fast jacks (two plain notes in one column within a quarter beat, at least 90 ms) by moving the
 * later note to the nearest column that is free at that time and has no note that close before or
 * after it. Timing is unchanged; a jack with no free column stays. Long notes are left as they are, and
 * so are jacks in rows of more than `maxRowSize` notes.
 * Returns the new map and how many notes moved.
 */
export function breakFastJacks(map: Beatmap, opts: { maxRowSize?: number } = {}): { map: Beatmap; moved: number } {
  const out = cloneBeatmap(map);
  const K = getKeys(out);
  out.notes = sortNotes(out.notes);
  const gapAt = (t: number) => Math.max((redLineAt(out, t)?.beatLength ?? 500) / 4 + 2, 90);
  // per column, the notes in time order (kept up to date as notes move)
  const byCol: Note[][] = Array.from({ length: K }, () => []);
  for (const n of out.notes) byCol[n.column]?.push(n);
  const near = (c: number, t: number, gap: number, self: Note) => byCol[c].some((x) => x !== self && (Math.abs(x.time - t) < gap || (isLN(x) && x.time <= t && x.endTime! + gap > t)));
  let moved = 0;
  // rows of more notes than this keep their jacks (jacked chords are chordjack, a pattern of its own)
  const rowSize = new Map<number, number>();
  for (const n of out.notes) rowSize.set(n.time, (rowSize.get(n.time) ?? 0) + 1);
  const maxRow = opts.maxRowSize ?? K;
  for (const n of out.notes) {
    if (isLN(n) || (rowSize.get(n.time) ?? 0) > maxRow) continue;
    const col = byCol[n.column];
    const i = col.indexOf(n);
    const prev = col[i - 1];
    const gap = gapAt(n.time);
    if (!prev || isLN(prev) || n.time - prev.time > gap) continue;
    // nearest free column, alternating sides, the same hand first (the middle column of odd keys is shared)
    const hand = (c: number) => (c * 2 + 1 < K ? 0 : c * 2 + 1 > K ? 1 : -1);
    const cost = (c: number) => Math.abs(c - n.column) * 2 + (hand(c) === hand(n.column) || hand(c) < 0 ? 0 : 1);
    const order = Array.from({ length: K }, (_, c) => c).filter((c) => c !== n.column).sort((a, b) => cost(a) - cost(b) || a - b);
    const to = order.find((c) => !near(c, n.time, gap, n));
    if (to === undefined) continue;
    col.splice(i, 1);
    n.column = to;
    const dest = byCol[to];
    let j = 0;
    while (j < dest.length && dest[j].time < n.time) j++;
    dest.splice(j, 0, n);
    moved++;
  }
  out.notes = sortNotes(out.notes);
  return { map: out, moved };
}

// ---------------------------------------------------------------- statistics

export interface Stats {
  keys: number;
  notes: number;
  rice: number;
  lns: number;
  lnPercent: number;
  firstTime: number;
  lastTime: number;
  drainSeconds: number;
  avgNps: number;
  peakNps: number;
  /** count of notes per column */
  columnCounts: number[];
  /** chordSizes[i] = number of chords with i+1 notes */
  chordSizes: number[];
  /** notes that repeat the same column as the previous chord */
  jacks: number;
  mainBpm: number;
}

export function stats(map: Beatmap): Stats {
  const k = getKeys(map);
  const notes = sortNotes([...map.notes]);
  const lns = notes.filter(isLN).length;
  const first = notes[0]?.time ?? 0;
  const last = notes.reduce((m, n) => Math.max(m, n.endTime ?? n.time), 0);
  const drain = Math.max(0.001, (last - first) / 1000);
  // peak NPS over a sliding 1 s window
  let peak = 0;
  let j = 0;
  for (let i = 0; i < notes.length; i++) {
    while (notes[i].time - notes[j].time >= 1000) j++;
    peak = Math.max(peak, i - j + 1);
  }
  const columnCounts = new Array(k).fill(0);
  notes.forEach((n) => columnCounts[n.column]++);
  const chordSizes = new Array(k).fill(0);
  let jacks = 0;
  let prev = new Set<number>();
  for (const ch of chords(notes)) {
    chordSizes[Math.min(k, ch.length) - 1]++;
    const cur = new Set(ch.map((n) => n.column));
    cur.forEach((c) => { if (prev.has(c)) jacks++; });
    prev = cur;
  }
  // main BPM = the red line covering the most time
  const reds = map.timingPoints.filter((t) => t.uninherited).sort((a, b) => a.time - b.time);
  let mainBpm = reds[0] ? 60000 / reds[0].beatLength : 0;
  let best = -1;
  reds.forEach((r, i) => {
    const end = reds[i + 1]?.time ?? last;
    const dur = end - Math.max(r.time, first);
    if (dur > best) { best = dur; mainBpm = 60000 / r.beatLength; }
  });
  return {
    keys: k,
    notes: notes.length,
    rice: notes.length - lns,
    lns,
    lnPercent: notes.length ? (100 * lns) / notes.length : 0,
    firstTime: first,
    lastTime: last,
    drainSeconds: drain,
    avgNps: notes.length / drain,
    peakNps: peak,
    columnCounts,
    chordSizes,
    jacks,
    mainBpm: Math.round(mainBpm * 100) / 100,
  };
}

// smart converters (kept in their own files)
export { convertKeysSmart, type SmartConvertOptions } from './keyconvert';
export { lnConvert, LN_PRESETS, type LnOptions, type LnPreset } from './lnconvert';
export { dirt, type Dirt } from './cleanliness';
