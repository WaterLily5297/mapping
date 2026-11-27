/**
 * "Smart" key-count conversion (any N -> any M, 1..18) that avoids dirty arrangements.
 *
 * Idea: inside one segment (a measure by default) every source column maps to one target
 * column through a *monotone* mapping (left stays left), so the original pattern shape is
 * kept exactly: a stream stays a stream, a trill stays a trill, jacks stay jacks and no new
 * jacks appear inside the segment. Between segments the mapping may change, so all target
 * columns get used. For each segment all monotone mappings (sampled when there are very many)
 * are scored and the cleanest one is chosen:
 *   - notes lost to collisions (down-conversion) or to a held LN
 *   - new jacks that the source did not have, weighted by speed
 *   - one hand pressing 3+ notes in fast rows
 *   - column balance (all columns used about equally over time)
 *   - a small cost for changing the mapping (keeps the flow stable)
 * Optional `fill` adds chord notes when converting up (denser, like real higher-key maps),
 * placed only where they create no jack and no hand overload.
 */
import { type Beatmap, type Note, cloneBeatmap, getKeys, setKeys, isLN, sortNotes, makeNote } from '../core/beatmap';
import { redLineAt } from '../core/timing';
import { rng } from '../core/rng';
import { handOf } from '../analysis/patterns';

export interface SmartConvertOptions {
  seed?: number;
  /** segment length in beats (default 4 = one measure) */
  segmentBeats?: number;
  /** 0..1: chance to add a chord note to a row when converting up (default 0) */
  fill?: number;
  /** also allow mirrored mappings (default true): more variety, same cleanliness */
  mirror?: boolean;
  /**
   * when adding keys, move the source's jacks (same column within 1/2 beat) onto other columns,
   * like real higher-key maps (4K maps have many minijacks/anchors, 7K maps few). Default false.
   */
  spreadJacks?: boolean;
}

const MAX_MAPPINGS = 600;

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const rec = (start: number) => {
    if (out.length > 20000) return;
    if (cur.length === k) { out.push([...cur]); return; }
    for (let i = start; i <= n - (k - cur.length); i++) { cur.push(i); rec(i + 1); cur.pop(); }
  };
  rec(0);
  return out;
}

/** All monotone mappings source column -> target column. */
export function monotoneMappings(N: number, M: number): number[][] {
  if (N <= M) return combinations(M, N); // injective: choose N target columns in order
  // surjective: cut the N source columns into M consecutive groups (choose M-1 cut points)
  return combinations(N - 1, M - 1).map((cuts) => {
    const map: number[] = [];
    let g = 0;
    for (let c = 0; c < N; c++) {
      map.push(g);
      if (cuts.includes(c)) g++;
    }
    return map;
  });
}

interface ColState { lastHit: number; lastSrc: number; busyUntil: number }

export function convertKeysSmart(map: Beatmap, targetKeys: number, opts: SmartConvertOptions = {}): Beatmap {
  const out = cloneBeatmap(map);
  const N = getKeys(map);
  const M = targetKeys;
  setKeys(out, M);
  const v = out.metadata.get('Version');
  if (v !== undefined && N !== M) out.metadata.set('Version', /\b\d+K\b/i.test(v) ? v.replace(/\b\d+K\b/i, `${M}K`) : `${v} (${M}K)`);
  if (N === M) return out;

  const rand = rng(opts.seed ?? 1);
  let maps = monotoneMappings(N, M);
  if (opts.mirror !== false) maps = maps.concat(maps.map((m) => m.map((t) => M - 1 - t)));
  if (maps.length > MAX_MAPPINGS) {
    // keep the "proportional" mapping plus a seeded sample
    const prop = Array.from({ length: N }, (_, c) => Math.min(M - 1, Math.floor(((c + 0.5) * M) / N)));
    const sample = [...maps].sort(() => rand() - 0.5).slice(0, MAX_MAPPINGS - 1);
    maps = [prop, ...sample];
  }

  // rows grouped into segments
  const notes = sortNotes(out.notes.map((n) => ({ ...n })));
  const rows: Note[][] = [];
  for (const n of notes) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(r[0].time - n.time) <= 1) r.push(n); else rows.push([n]);
  }
  const segOf = (t: number) => {
    const r = redLineAt(map, t);
    const beat = r?.beatLength ?? 500;
    return Math.floor((t - (r?.time ?? 0)) / (beat * (opts.segmentBeats ?? 4))) + (r ? Math.round(r.time) * 1e3 : 0);
  };
  const segments: Note[][][] = [];
  let lastSeg = NaN;
  for (const r of rows) {
    const s = segOf(r[0].time);
    if (s !== lastSeg) { segments.push([]); lastSeg = s; }
    segments[segments.length - 1].push(r);
  }

  const st: ColState[] = Array.from({ length: M }, () => ({ lastHit: -Infinity, lastSrc: -1, busyUntil: -Infinity }));
  const usage = new Array<number>(M).fill(0);
  // cumulative hand counts: source hands of all notes, target hands (middle column = half each)
  const cumSrc = [0, 0];
  const cumTgt = [0, 0];
  let total = 0;
  let prevMap: number[] | null = null;
  const result: Note[] = [];

  const spread = !!opts.spreadJacks && M > N;
  const simulate = (mapping: number[], seg: Note[][], commit: boolean) => {
    // copy of the column state so scoring does not change anything
    const s = commit ? st : st.map((x) => ({ ...x }));
    const use = commit ? usage : [...usage];
    let cost = 0;
    let lastRowT = -Infinity;
    const srcHands = commit ? cumSrc : [...cumSrc];
    const tgtHands = commit ? cumTgt : [...cumTgt];
    const ratio = (h: number[]) => (h[0] + h[1] ? Math.abs(h[0] - h[1]) / (h[0] + h[1]) : 0);
    const before = Math.max(0, ratio(tgtHands) - ratio(srcHands));
    let segNotes = 0;
    const segSrc = [0, 0];
    const segTgt = [0, 0];
    for (const row of seg) {
      const t = row[0].time;
      const beat = redLineAt(map, t)?.beatLength ?? 500;
      const fast = t - lastRowT <= beat / 4 + 2;
      lastRowT = t;
      const placed = new Set<number>();
      const hands = [0, 0];
      for (const n of row) {
        // a target column is clean if it is free (no chord collision, no held LN) and does not
        // create a fast jack the source did not have
        const clean = (c: number) => {
          if (placed.has(c)) return false;
          const cs = s[c];
          if (t <= cs.busyUntil + 1) return false;
          if (spread && t - cs.lastHit <= beat / 2 + 2) return false; // spread: no jacks at all here
          return !(cs.lastSrc !== n.column && t - cs.lastHit <= beat / 4 + 2);
        };
        let tc = mapping[n.column];
        if (!clean(tc)) {
          // repair: move the note to the nearest clean column, same hand first; else drop it
          const want = handOf(tc, M);
          const alt = [...Array(M).keys()].filter((c) => c !== tc && clean(c))
            .sort((a, b) => (Number(handOf(a, M) !== want) - Number(handOf(b, M) !== want)) || (Math.abs(a - tc) - Math.abs(b - tc)));
          if (!alt.length) { cost += 6; continue; }
          tc = alt[0];
          cost += 2;
        }
        const cs = s[tc];
        // a slower (1/2 beat) jack the source did not have: allowed but not preferred
        if (cs.lastSrc !== n.column && t - cs.lastHit <= beat / 2 + 2) cost += 2;
        // keep the source's hand structure (left-hand notes stay on the left hand)
        const sh = handOf(n.column, N);
        const th = handOf(tc, M);
        if (sh !== -1 && th !== -1 && sh !== th) cost += 0.6;
        placed.add(tc);
        const h = handOf(tc, M);
        if (h !== -1) hands[h]++;
        if (commit) {
          const nn: Note = { ...n, column: tc };
          result.push(nn);
        }
        cs.lastHit = t;
        cs.lastSrc = n.column;
        cs.busyUntil = isLN(n) ? n.endTime! : t;
        // balance: a note costs more in a column that is already used more than its share
        const seen = Object.values(use).reduce((x, y) => x + y, 0);
        if (seen > M * 4) {
          const share = use[tc] / seen;
          cost += (share - 1 / M) * M * 0.3; // negative for under-used columns
          if (share < 0.25 / M) cost -= 0.5; // make sure every column gets used
        }
        use[tc]++;
        for (const [hs, h] of [[srcHands, sh], [segSrc, sh], [tgtHands, th], [segTgt, th]] as [number[], number][]) {
          if (h !== -1) hs[h]++; else { hs[0] += 0.5; hs[1] += 0.5; }
        }
        segNotes++;
      }
      if (fast && (hands[0] >= 3 || hands[1] >= 3)) cost += 4;
    }
    // hand balance over the song so far: no more one-sided than the source itself
    const after = Math.max(0, ratio(tgtHands) - ratio(srcHands));
    cost += (after - before) * Math.max(segNotes, 1) * 2;
    // and inside this segment (what a player feels): no more one-sided than the source here
    cost += 0.5 * Math.max(0, Math.abs(segTgt[0] - segTgt[1]) - Math.abs(segSrc[0] - segSrc[1]));
    return { cost, use };
  };

  for (const seg of segments) {
    let best: { m: number[]; score: number } | null = null;
    const segNotes = seg.reduce((a, r) => a + r.length, 0);
    for (const m of maps) {
      const { cost } = simulate(m, seg, false);
      // balance: squared deviation from equal use after this segment
      const pm: number[] | null = prevMap;
      const change: number = pm && pm.some((x, i) => x !== m[i]) ? 0.5 : 0;
      const score: number = cost + change + rand() * 0.05;
      if (!best || score < best.score) best = { m, score };
    }
    simulate(best!.m, seg, true);
    total += segNotes;
    prevMap = best!.m;
  }

  let notesOut = result;
  if ((opts.fill ?? 0) > 0 && M > N) notesOut = fillChords(map, result, M, opts.fill!, rand);
  out.notes = sortNotes(notesOut);
  return out;
}

/** Add chord notes in free columns where that creates no jack, no hand overload and no LN clash. */
function fillChords(map: Beatmap, notes: Note[], M: number, fill: number, rand: () => number): Note[] {
  const sorted = sortNotes([...notes]);
  const rows: Note[][] = [];
  for (const n of sorted) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(r[0].time - n.time) <= 1) r.push(n); else rows.push([n]);
  }
  const added: Note[] = [];
  const lastHit = new Array<number>(M).fill(-Infinity);
  const busy = new Array<number>(M).fill(-Infinity);
  const colTimes: number[][] = Array.from({ length: M }, () => []);
  for (const n of sorted) colTimes[n.column].push(n.time);
  const nextHit = (c: number, t: number) => {
    const a = colTimes[c];
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= t + 1) lo = m + 1; else hi = m; }
    return lo < a.length ? a[lo] : Infinity;
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const t = row[0].time;
    const beat = redLineAt(map, t)?.beatLength ?? 500;
    for (const n of row) { lastHit[n.column] = t; busy[n.column] = isLN(n) ? n.endTime! : t; }
    // only on beats / half beats (where real maps put chords), and only sometimes
    const r = redLineAt(map, t);
    const pos = r ? ((t - r.time) / beat) % 1 : 0;
    const onBeat = Math.min(pos, 1 - pos) < 0.02 || Math.abs(pos - 0.5) < 0.02;
    if (!onBeat || rand() >= fill) continue;
    const hands = [0, 0];
    for (const n of row) { const h = handOf(n.column, M); if (h !== -1) hands[h]++; }
    const used = new Set(row.map((n) => n.column));
    const cands = [...Array(M).keys()].filter((c) => {
      if (used.has(c) || t <= busy[c] + 1) return false;
      if (t - lastHit[c] <= beat / 2 + 2) return false; // would be a jack with the previous note
      if (nextHit(c, t) - t <= beat / 2 + 2) return false; // would be a jack with the next note
      const h = handOf(c, M);
      return h === -1 || hands[h] < 2;
    });
    if (!cands.length) continue;
    // prefer the hand with fewer notes in this row
    const load = (c: number) => { const h = handOf(c, M); return h === -1 ? Math.min(hands[0], hands[1]) : hands[h]; };
    cands.sort((a, b) => load(a) - load(b) + (rand() - 0.5) * 0.5);
    const c = cands[0];
    const nn = makeNote(t, c);
    added.push(nn);
    lastHit[c] = t;
    busy[c] = t;
  }
  return [...notes, ...added];
}
