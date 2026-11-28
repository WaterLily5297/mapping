/**
 * Long notes from the audio, learned from ranked LN maps (scripts/bench/train-ln-model.ts):
 *   heads  which notes become long: does the sound stay up after the note (loudness over the next
 *          1/4..2 beats, how steady the spectrum is), how much room there is, drum-like cues
 *   tails  where a long note ends: candidate ends on the 1/4 and 1/8 grid, scored by whether a new
 *          sound starts there, the loudness drops there, another note sits on that row, the beat
 *          position and the length
 * placeLongNotes() makes the most likely `share` of the notes long and ends each at its most
 * likely candidate.
 */
import { type Beatmap, type Note, isLN, sortNotes } from '../core/beatmap';
import { redLineAt, snapTime } from '../core/timing';
import type { Analysis } from './analysis';
import { LN_MODEL, type LnModel } from './lnmodel';

export const LN_HEAD_FEATURES = [
  'loudness', 'loud +1/4', 'loud +1/2', 'loud +1', 'loud +2', 'flux next beat', 'centroid change', 'room (log2 beats)',
  'gap to next row', 'gap from previous row', 'chord size', 'on beat', 'on half', 'onset strength', 'high band', 'low band', 'bias',
  'flatness next beat', 'flatness at head', 'flatness change',
];
export const LN_TAIL_FEATURES = [
  'log2 length', 'length', 'on beat', 'on half', 'on quarter', 'onset at end', 'loudness drop', 'loudness vs head',
  'row at end', 'before next head', 'longest', 'bias',
  'strongest onset', 'onset vs strongest', 'first row after head', 'rows passed (log2)', 'share of room', 'flatness at end',
];

interface Ctx { a: Analysis; rmsMean: number; fluxMean: number }
const frameOf = (a: Analysis, t: number) => Math.max(0, Math.min(a.rms.length - 1, Math.round(t / 1000 / a.frameDur)));
const maxAround = (arr: Float32Array, f: number, r: number) => { let m = 0; for (let j = f - r; j <= f + r; j++) if (j >= 0 && j < arr.length && arr[j] > m) m = arr[j]; return m; };
const meanOver = (arr: Float32Array, f0: number, f1: number) => { let s = 0, n = 0; for (let j = Math.max(0, f0); j < Math.min(arr.length, f1); j++) { s += arr[j]; n++; } return n ? s / n : 0; };

function context(a: Analysis): Ctx {
  return { a, rmsMean: meanOver(a.rms, 0, a.rms.length) || 1e-6, fluxMean: meanOver(a.flux, 0, a.flux.length) || 1e-6 };
}
function beatPos(map: Beatmap, t: number): { beat: number; frac: number } {
  const r = redLineAt(map, t);
  const beat = r?.beatLength ?? 500;
  const b = (t - (r?.time ?? 0)) / beat;
  return { beat, frac: b - Math.floor(b) };
}
const onDiv = (frac: number, d: number) => Math.abs(frac * d - Math.round(frac * d)) < 0.02;

interface Layout { rows: number[]; rowSize: Map<number, number>; nextInCol: Map<Note, number> }
function layout(notes: Note[]): Layout {
  const sorted = sortNotes([...notes]);
  const rowSize = new Map<number, number>();
  for (const n of sorted) rowSize.set(n.time, (rowSize.get(n.time) ?? 0) + 1);
  const rows = [...rowSize.keys()].sort((x, y) => x - y);
  const nextInCol = new Map<Note, number>(), last = new Map<number, Note>();
  for (const n of sorted) { const p = last.get(n.column); if (p) nextInCol.set(p, n.time); last.set(n.column, n); }
  return { rows, rowSize, nextInCol };
}
const nextRowAfter = (rows: number[], t: number) => { let lo = 0, hi = rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m] <= t) lo = m + 1; else hi = m; } return rows[lo]; };
const prevRowBefore = (rows: number[], t: number) => { let lo = 0, hi = rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m] < t) lo = m + 1; else hi = m; } return rows[lo - 1]; };

export function headFeatures(c: Ctx, map: Beatmap, L: Layout, n: Note): number[] {
  const { a } = c;
  const { beat, frac } = beatPos(map, n.time);
  const f = frameOf(a, n.time), fb = (beats: number) => frameOf(a, n.time + beats * beat);
  const r0 = Math.max(1e-6, meanOver(a.rms, f, f + 3));
  const ratio = (beats: number) => meanOver(a.rms, fb(beats) - 1, fb(beats) + 2) / r0;
  const next = L.nextInCol.get(n) ?? n.time + beat * 8;
  const nr = nextRowAfter(L.rows, n.time) ?? n.time + beat * 4, pr = prevRowBefore(L.rows, n.time) ?? n.time - beat * 4;
  return [
    r0 / c.rmsMean, ratio(0.25), ratio(0.5), ratio(1), ratio(2),
    meanOver(a.flux, f + 3, fb(1)) / c.fluxMean, Math.abs(meanOver(a.centroid, fb(0.5), fb(1)) - meanOver(a.centroid, f, f + 3)),
    Math.log2(Math.max(0.125, (next - n.time) / beat)), Math.log2(Math.max(0.0625, (nr - n.time) / beat)), Math.log2(Math.max(0.0625, (n.time - pr) / beat)),
    L.rowSize.get(n.time) ?? 1, onDiv(frac, 1) ? 1 : 0, !onDiv(frac, 1) && onDiv(frac, 2) ? 1 : 0,
    maxAround(a.flux, f, 2), maxAround(a.bands[2], f, 2), maxAround(a.bands[0], f, 2), 1,
    a.flatness ? meanOver(a.flatness, f + 3, fb(1)) : 0.5, a.flatness ? meanOver(a.flatness, f, f + 3) : 0.5,
    a.flatness ? meanOver(a.flatness, fb(0.5), fb(1)) - meanOver(a.flatness, f, f + 3) : 0,
  ];
}

/** candidate ends of a long note on the 1/4 and 1/8 grid (at least 1/4 beat long, ending 1/8 beat before the next note in its column, at most 8 beats) */
export function tailCandidates(map: Beatmap, L: Layout, n: Note): number[] {
  const { beat } = beatPos(map, n.time);
  const limit = Math.min((L.nextInCol.get(n) ?? Infinity) - beat / 8 + 1, n.time + beat * 8);
  const out: number[] = [];
  for (let k = 2; ; k++) {
    const t = snapTime(map, n.time + (k * beat) / 8, 8);
    if (t > limit) break;
    if (t - n.time >= beat / 4 - 1 && (!out.length || t > out[out.length - 1])) out.push(t);
  }
  return out;
}

/** features of every candidate end of one long note, including how each compares with the others */
export function tailGroupFeatures(c: Ctx, map: Beatmap, L: Layout, n: Note, cands: number[]): number[][] {
  const base = cands.map((e, i) => tailFeatures(c, map, L, n, e, i === cands.length - 1));
  const strongest = Math.max(1e-6, ...base.map((x) => x[5]));
  const firstRow = nextRowAfter(L.rows, n.time);
  const room = Math.max(1, (L.nextInCol.get(n) ?? cands[cands.length - 1]) - n.time);
  return base.map((x, i) => {
    const e = cands[i];
    let passed = 0;
    for (const r of L.rows) if (r > n.time && r <= e + 2) passed++;
    return [...x, x[5] >= strongest - 1e-9 ? 1 : 0, x[5] / strongest, firstRow !== undefined && Math.abs(firstRow - e) <= 2 ? 1 : 0,
      Math.log2(1 + passed), (e - n.time) / room, c.a.flatness ? meanOver(c.a.flatness, frameOf(c.a, e) - 3, frameOf(c.a, e)) : 0.5];
  });
}

export function tailFeatures(c: Ctx, map: Beatmap, L: Layout, n: Note, e: number, isLast: boolean): number[] {
  const { a } = c;
  const { beat, frac } = beatPos(map, e);
  const len = (e - n.time) / beat;
  const f = frameOf(a, e);
  const before = Math.max(1e-6, meanOver(a.rms, f - 4, f)), after = meanOver(a.rms, f + 1, f + 5);
  const head = Math.max(1e-6, meanOver(a.rms, frameOf(a, n.time), frameOf(a, n.time) + 3));
  const nextHead = L.nextInCol.get(n);
  return [
    Math.log2(len), len, onDiv(frac, 1) ? 1 : 0, !onDiv(frac, 1) && onDiv(frac, 2) ? 1 : 0, !onDiv(frac, 2) && onDiv(frac, 4) ? 1 : 0,
    maxAround(a.flux, f, 2), after / before, before / head,
    L.rowSize.has(e) || L.rows.some((r) => Math.abs(r - e) <= 2) ? 1 : 0,
    nextHead !== undefined ? Math.max(0, 1 - (nextHead - e) / beat) : 0, isLast ? 1 : 0, 1,
  ];
}

const dot = (w: number[], mean: number[], std: number[], x: number[]) => x.reduce((s, v, i) => s + (w[i] ?? 0) * (std[i] > 0 ? (v - mean[i]) / std[i] : v), 0);

/** Make the most likely `share` of the notes long (in place), ending each at its most likely candidate. */
/** added to each tail candidate's score per doubling of its length in beats (0: the model as trained) */
let LN_LENGTH_BIAS = 0;
/** benchmarks only */
export function _setLnLengthBias(v: number) { LN_LENGTH_BIAS = v; }

export function placeLongNotes(map: Beatmap, a: Analysis, share: number, model: LnModel | null = LN_MODEL, lengthBias = LN_LENGTH_BIAS): number {
  if (!model || share <= 0 || !map.notes.length) return 0;
  const c = context(a), L = layout(map.notes);
  const scored = map.notes.filter((n) => !isLN(n)).map((n) => ({ n, s: dot(model.head.w, model.head.mean, model.head.std, headFeatures(c, map, L, n)) }))
    .sort((x, y) => y.s - x.s);
  const want = Math.round(share * map.notes.length);
  let made = 0;
  for (const { n } of scored) {
    if (made >= want) break;
    const cands = tailCandidates(map, L, n);
    if (!cands.length) continue;
    let best = cands[0], bs = -Infinity;
    const beat = beatPos(map, n.time).beat;
    tailGroupFeatures(c, map, L, n, cands).forEach((x, i) => {
      const s = dot(model.tail.w, model.tail.mean, model.tail.std, x) + lengthBias * Math.log2(Math.max(1e-3, (cands[i] - n.time) / beat));
      if (s > bs) { bs = s; best = cands[i]; }
    });
    n.endTime = best;
    made++;
  }
  return made;
}

export { context as lnContext, layout as lnLayout };
