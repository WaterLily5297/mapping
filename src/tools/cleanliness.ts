/**
 * "Dirty arrangement" metrics: things that make a converted chart awkward or unplayable even
 * when it is technically valid. All rates are per 1000 notes (or a 0..1 share), so maps of
 * different length compare. Used to check converters against real ranked maps.
 */
import { type Beatmap, type Note, getKeys, isLN, sortNotes } from '../core/beatmap';
import { redLineAt, snapTime } from '../core/timing';
import { handOf } from '../analysis/patterns';

export interface Dirt {
  notes: number;
  /** same column again within 1/4 beat (or 90 ms): very fast jacks */
  fastJacks: number;
  /** same column again within 1/2 beat */
  jacks: number;
  /** fast rows (<= 1/4 beat apart) where one hand must press 3+ notes */
  handOverload: number;
  /** fast transitions that stay on the same hand while the other hand is idle (awkward one-hand runs) */
  oneHandRuns: number;
  /** mean |left - right| / (left + right) over 8-beat windows (0 = balanced) */
  handImbalance: number;
  /** LNs shorter than 1/8 beat (or 60 ms) */
  shortLNs: number;
  /** LN released less than 1/8 beat (or 45 ms) before the next note in its column (not inverse spacing) */
  tightReleases: number;
  /** LN releases that are not on a 1/16 or 1/12 grid line */
  offGridReleases: number;
  /** while holding an LN, same-hand neighbour notes faster than 1/4 beat (hard column lock) */
  lockedHolds: number;
  /** one number: weighted sum of the above (lower = cleaner) */
  score: number;
}

const per1000 = (x: number, n: number) => (n ? (x * 1000) / n : 0);

export function dirt(map: Beatmap): Dirt {
  const K = getKeys(map);
  const notes = sortNotes([...map.notes]);
  const n = notes.length;
  const beatAt = (t: number) => redLineAt(map, t)?.beatLength ?? 500;

  // per column
  let fastJacks = 0, jacks = 0, shortLNs = 0, tight = 0, offGrid = 0;
  const byCol: Note[][] = Array.from({ length: K }, () => []);
  for (const x of notes) byCol[x.column]?.push(x);
  for (const col of byCol) {
    for (let i = 0; i < col.length; i++) {
      const a = col[i];
      const b = col[i + 1];
      const beat = beatAt(a.time);
      if (b) {
        const end = isLN(a) ? a.endTime! : a.time;
        const g = b.time - a.time;
        if (!isLN(a)) {
          if (g <= Math.max(beat / 4 + 2, 90)) fastJacks++;
          if (g <= beat / 2 + 2) jacks++;
        } else {
          const rel = b.time - end;
          if (rel < Math.max(beat / 8 - 2, 45)) tight++;
        }
      }
      if (isLN(a)) {
        const len = a.endTime! - a.time;
        if (len < Math.max(beat / 8, 60)) shortLNs++;
        const onGrid = [16, 12].some((d) => Math.abs(snapTime(map, a.endTime!, d) - a.endTime!) <= 2);
        if (!onGrid) offGrid++;
      }
    }
  }

  // rows / hands
  const rows: { t: number; cols: number[] }[] = [];
  for (const x of notes) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(r.t - x.time) <= 1) r.cols.push(x.column);
    else rows.push({ t: x.time, cols: [x.column] });
  }
  const handsOf = (cols: number[]) => {
    const h = [0, 0];
    for (const c of cols) {
      const s = handOf(c, K);
      if (s === -1) continue;
      h[s]++;
    }
    return h;
  };
  let overload = 0, oneHand = 0;
  for (let i = 1; i < rows.length; i++) {
    const g = rows[i].t - rows[i - 1].t;
    const fast = g <= beatAt(rows[i].t) / 4 + 2;
    const h = handsOf(rows[i].cols);
    if (fast && (h[0] >= 3 || h[1] >= 3)) overload++;
    if (fast && K >= 4) {
      const p = handsOf(rows[i - 1].cols);
      const same = (h[0] && !h[1] && p[0] && !p[1]) || (h[1] && !h[0] && p[1] && !p[0]);
      if (same) oneHand++;
    }
  }
  // hand balance over 8-beat windows
  const imb: number[] = [];
  if (rows.length) {
    let i = 0;
    while (i < rows.length) {
      const t0 = rows[i].t;
      const w = beatAt(t0) * 8;
      const h = [0, 0];
      while (i < rows.length && rows[i].t < t0 + w) { const x = handsOf(rows[i].cols); h[0] += x[0]; h[1] += x[1]; i++; }
      if (h[0] + h[1] >= 8) imb.push(Math.abs(h[0] - h[1]) / (h[0] + h[1]));
    }
  }
  // column lock: holding an LN while the same hand's neighbour column is hit fast
  let locked = 0;
  for (const ln of notes.filter(isLN)) {
    const hand = handOf(ln.column, K);
    if (hand === -1) continue;
    const beat = beatAt(ln.time);
    const inside = notes.filter((x) => x.time > ln.time + 1 && x.time < ln.endTime! - 1 && x.column !== ln.column && handOf(x.column, K) === hand);
    for (let i = 1; i < inside.length; i++) if (inside[i].time - inside[i - 1].time <= beat / 4 + 2) locked++;
  }

  const d = {
    notes: n,
    fastJacks: per1000(fastJacks, n),
    jacks: per1000(jacks, n),
    handOverload: per1000(overload, n),
    oneHandRuns: per1000(oneHand, n),
    handImbalance: imb.length ? imb.reduce((a, b) => a + b, 0) / imb.length : 0,
    shortLNs: per1000(shortLNs, n),
    tightReleases: per1000(tight, n),
    offGridReleases: per1000(offGrid, n),
    lockedHolds: per1000(locked, n),
    score: 0,
  };
  d.score = d.fastJacks * 1 + d.jacks * 0.25 + d.handOverload * 1.5 + d.oneHandRuns * 0.3 + d.handImbalance * 100
    + d.shortLNs * 1 + d.tightReleases * 1 + d.offGridReleases * 0.5 + d.lockedHolds * 0.5;
  return d;
}
