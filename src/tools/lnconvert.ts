/**
 * Smart LN conversion (rice -> long notes) that avoids dirty LN arrangements.
 *
 * Like krrcream's LN Transformer, notes are split by the free time to the next note in the
 * same column: "short" gaps and "long" gaps get their own share (how many become LNs) and
 * level (how much of the gap the LN fills). On top of that, every LN is checked:
 *   - its end snaps to a grid (1/4, 1/8 ... of a beat), never off-grid
 *   - it is released at least `releaseGap` before the next note in its column
 *   - it is at least `minBeats` long, otherwise the note stays a normal note
 *   - it may not hold through a fast run on the same hand's other columns (hard column lock),
 *     unless `allowLocks` (inverse-style maps do that on purpose)
 * Existing LNs are kept.
 */
import { type Beatmap, type Note, cloneBeatmap, getKeys, isLN, sortNotes } from '../core/beatmap';
import { redLineAt, snapTime } from '../core/timing';
import { rng } from '../core/rng';
import { handOf } from '../analysis/patterns';

export interface LnGroup {
  /** 0..1 share of notes in this group that become LNs */
  ratio: number;
  /** 0..1 how much of the free time the LN fills */
  level: number;
}

export interface LnOptions {
  /** gap (beats) separating short from long groups (default 1 beat) */
  threshold?: number;
  short?: LnGroup;
  long?: LnGroup;
  /** 0..1 random variation of the level (default 0.2) */
  random?: number;
  /** grid for LN ends: 4 = 1/4 beat, 8 = 1/8 ... (default 8) */
  align?: number;
  /** minimum time between release and the next press in the column, in beats (default 1/4) */
  releaseGap?: number;
  /** minimum LN length in beats (default 1/4) */
  minBeats?: number;
  /** allow holding through fast same-hand runs (inverse-style); default false */
  allowLocks?: boolean;
  /** LN length for the last note of a column, in beats (default 1) */
  lastBeats?: number;
  seed?: number;
  preset?: LnPreset;
}

export type LnPreset = 'light' | 'hybrid' | 'full' | 'inverse';

export const LN_PRESETS: Record<LnPreset, LnOptions> = {
  /** a few longer holds on sustained parts */
  light: { short: { ratio: 0, level: 0.5 }, long: { ratio: 0.35, level: 0.6 }, threshold: 1, random: 0.2, align: 4 },
  /** rice + LN mix */
  hybrid: { short: { ratio: 0.25, level: 0.5 }, long: { ratio: 0.7, level: 0.7 }, threshold: 1, random: 0.2, align: 8 },
  /** (almost) every note becomes an LN */
  full: { short: { ratio: 1, level: 0.75 }, long: { ratio: 1, level: 0.85 }, threshold: 1, random: 0.1, align: 8 },
  /** holds fill the gaps; the releases make the rhythm */
  inverse: { short: { ratio: 1, level: 1 }, long: { ratio: 1, level: 1 }, threshold: 1, random: 0, align: 8, releaseGap: 0.25, allowLocks: true },
};

export function lnConvert(map: Beatmap, opts: LnOptions = {}): Beatmap {
  const o: LnOptions = { ...(opts.preset ? LN_PRESETS[opts.preset] : LN_PRESETS.hybrid), ...stripUndefined(opts) };
  const out = cloneBeatmap(map);
  const K = getKeys(out);
  const rand = rng(o.seed ?? 1);
  const notes = sortNotes(out.notes);
  const byCol: Note[][] = Array.from({ length: K }, () => []);
  for (const n of notes) byCol[n.column].push(n);
  // per hand: sorted note times, to check what an LN would hold through
  const handTimes: { t: number; c: number }[][] = [[], []];
  for (const n of notes) {
    const h = handOf(n.column, K);
    if (h !== -1) handTimes[h].push({ t: n.time, c: n.column });
  }

  for (const col of byCol) {
    for (let i = 0; i < col.length; i++) {
      const n = col[i];
      if (isLN(n)) continue;
      const beat = redLineAt(out, n.time)?.beatLength ?? 500;
      const next = col[i + 1];
      const free = next ? next.time - n.time : (o.lastBeats ?? 1) * beat * 1.5;
      const group = free < (o.threshold ?? 1) * beat ? o.short! : o.long!;
      if (!(group.ratio > 0) || rand() >= group.ratio) continue;
      const jitter = 1 + ((rand() * 2 - 1) * (o.random ?? 0.2));
      const releaseGap = Math.max((o.releaseGap ?? 0.25) * beat, 60);
      const latest = next ? next.time - releaseGap : n.time + (o.lastBeats ?? 1) * beat;
      let end = n.time + Math.min(free * group.level * jitter, latest - n.time);
      // snap the release down onto the grid so it never lands closer to the next note
      const align = o.align ?? 8;
      if (align > 0 && redLineAt(out, end)) {
        let s = snapTime(out, end, align);
        if (s > latest) s = snapTime(out, s - beat / align, align);
        end = s;
      }
      if (end - n.time < Math.max((o.minBeats ?? 0.25) * beat - 2, 60)) continue; // too short: keep rice
      if (!o.allowLocks) {
        // shorten (or skip) when the hold would cover a fast run on the same hand's other columns
        const h = handOf(n.column, K);
        if (h !== -1) {
          const inside = handTimes[h].filter((x) => x.c !== n.column && x.t > n.time + 1 && x.t < end - 1);
          for (let j = 1; j < inside.length; j++) {
            if (inside[j].t - inside[j - 1].t <= beat / 4 + 2) {
              end = Math.min(end, inside[j - 1].t); // release before the run continues
              break;
            }
          }
          if (align > 0 && redLineAt(out, end)) end = Math.min(end, snapTime(out, end, align));
          if (end - n.time < Math.max((o.minBeats ?? 0.25) * beat - 2, 60)) continue;
        }
      }
      n.endTime = Math.round(end);
    }
  }
  out.notes = sortNotes(notes);
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
