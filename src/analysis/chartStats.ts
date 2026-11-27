/**
 * Whole-chart statistics + rule scores for osu! user tags, tournament slot and categories.
 *
 * Adapted (re-implemented in TypeScript) from Columnist / osu-patterns by Kominaru,
 * https://github.com/Kominaru/columnist — osu_patterns/mania.py, mania_tags.py, slots.py,
 * categories.py. Licensed under the Apache License 2.0; see THIRD_PARTY_NOTICES.md.
 * Changes: ported from Python/numpy, any key count, subset of statistics, no learned heads.
 *
 * Columnist's measurements (5,300 ranked diffs with osu! user-tag votes) show that these
 * hand rules are a reasonable baseline and that gradient-boosted heads on the same
 * statistics do clearly better (e.g. jumpstream AP 0.71 vs 0.53). Statistics are kept
 * in milliseconds on purpose (no snap / BPM grid), so live-timed maps work too.
 */
import { type Beatmap, getKeys, isLN, sortNotes } from '../core/beatmap';

export type ChartStats = Record<string, number>;

const sq = (x: number, mid: number, width: number) => 1 / (1 + Math.exp(-(x - mid) / Math.max(width, 1e-9)));
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pctl = (a: number[], q: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = (q / 100) * (s.length - 1);
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (i - lo);
};
const clip = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** "fast" gap: inside a pattern rather than a pause (about 1/4 at 270 BPM .. 1/2 at 136 BPM) */
const FAST_MS = 220;
/** an LN end this close to the next note in its column counts as inverse */
const INVERSE_GAP_MS = 150;

export function chartStats(map: Beatmap): ChartStats {
  const K = getKeys(map);
  const notes = sortNotes([...map.notes]);
  const n = notes.length;
  const s: ChartStats = { keys: K, notes: n };
  if (!n) return s;
  const start = notes.map((x) => x.time);
  const end = notes.map((x) => x.endTime ?? x.time);
  const t0 = start[0];
  const t1 = Math.max(...end);
  const dur = Math.max((t1 - t0) / 1000, 1);
  s.duration_s = dur;

  // ---- density
  s.nps = n / dur;
  s.nps_per_key = s.nps / K;
  const bins = Math.max(1, Math.ceil((t1 - t0 + 1) / 2000));
  const counts = new Array(bins).fill(0);
  for (const t of start) counts[Math.min(bins - 1, Math.floor((t - t0) / 2000))]++;
  const rate = counts.map((c) => c / 2);
  s.nps_p50 = pctl(rate, 50);
  s.nps_p90 = pctl(rate, 90);
  s.nps_max = Math.max(...rate);
  s.stamina = s.nps_p90 > 0 ? mean(rate.map((r) => (r >= 0.8 * s.nps_p90 ? 1 : 0))) : 0;
  s.breaks = mean(counts.map((c) => (c === 0 ? 1 : 0)));

  // ---- rows
  const rt: number[] = [];
  const rc: Set<number>[] = [];
  for (const x of notes) {
    if (rt.length && x.time - rt[rt.length - 1] <= 2) rc[rc.length - 1].add(x.column);
    else { rt.push(x.time); rc.push(new Set([x.column])); }
  }
  const R = rt.length;
  const sizes = rc.map((c) => c.size);
  s.row_single = mean(sizes.map((z) => +(z === 1)));
  s.row_jump = mean(sizes.map((z) => +(z === 2)));
  s.row_hand = mean(sizes.map((z) => +(z === 3)));
  s.row_quad = mean(sizes.map((z) => +(z >= 4)));
  const gaps: number[] = [];
  const overlap: number[] = [];
  for (let i = 1; i < R; i++) {
    gaps.push(rt[i] - rt[i - 1]);
    overlap.push([...rc[i]].filter((c) => rc[i - 1].has(c)).length);
  }
  if (!gaps.length) { gaps.push(1000); overlap.push(0); }
  const fast = gaps.map((g) => g < FAST_MS);
  const jackRows = fast.map((f, i) => f && overlap[i] > 0);
  s.jack_row = mean(jackRows.map(Number));
  s.jack_note = overlap.reduce((a, o, i) => a + (fast[i] ? o : 0), 0) / n;
  s.chordjack_row = mean(jackRows.map((j, i) => +(j && sizes[i + 1] >= 2 && sizes[i] >= 2)));
  s.stream_row = mean(fast.map((f, i) => +(f && overlap[i] === 0)));
  s.jumpstream_row = mean(fast.map((f, i) => +(f && overlap[i] === 0 && sizes[i + 1] === 2)));
  s.handstream_row = mean(fast.map((f, i) => +(f && overlap[i] === 0 && (sizes[i + 1] ?? 0) >= 3)));
  const jg = gaps.filter((_, i) => jackRows[i]);
  s.jack_gap_ms = jg.length ? pctl(jg, 50) : 400;
  s.row_gap_ms_p50 = pctl(gaps, 50);
  // jack chains: same column on >= 3 consecutive fast rows
  let chainHits = 0;
  let longest = 0;
  let cur = new Map<number, number>();
  for (let i = 1; i < R; i++) {
    if (!fast[i - 1]) { cur = new Map(); continue; }
    const nxt = new Map<number, number>();
    for (const c of rc[i]) if (rc[i - 1].has(c)) nxt.set(c, (cur.get(c) ?? 1) + 1);
    for (const v of nxt.values()) { if (v >= 3) chainHits++; longest = Math.max(longest, v); }
    cur = nxt;
  }
  s.jack_chain3 = chainHits / n;
  s.jack_longest = longest;
  let trill = 0;
  const eq = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((x) => b.has(x));
  for (let i = 3; i < R; i++) {
    if (fast[i - 1] && fast[i - 2] && fast[i - 3] && eq(rc[i], rc[i - 2]) && eq(rc[i - 1], rc[i - 3]) && ![...rc[i]].some((c) => rc[i - 1].has(c))) trill++;
  }
  s.trill_row = trill / Math.max(R, 1);

  // ---- rhythm (ms only)
  const variety: number[] = [];
  for (let i = 0; i < gaps.length; i += 16) {
    variety.push(new Set(gaps.slice(i, i + 16).filter((g) => g < 400).map((g) => Math.round(g / 5))).size);
  }
  s.rhythm_variety = mean(variety);
  const changes: number[] = [];
  for (let i = 1; i < gaps.length; i++) {
    if (fast[i]) changes.push(+(Math.abs(Math.log(Math.max(gaps[i], 5)) - Math.log(Math.max(gaps[i - 1], 5))) > 0.3));
  }
  s.gap_ratio_change = mean(changes);

  // ---- long notes
  const lnIdx = notes.map((x, i) => (isLN(x) ? i : -1)).filter((i) => i >= 0);
  const lens = lnIdx.map((i) => end[i] - start[i]);
  s.ln_ratio = lnIdx.length / n;
  s.ln_count_ps = lnIdx.length / dur;
  s.ln_len_ms_p50 = lens.length ? pctl(lens, 50) : 0;
  let inv = 0;
  let totLn = 0;
  const byCol: number[][] = Array.from({ length: K }, () => []);
  notes.forEach((x, i) => byCol[x.column].push(i));
  for (const col of byCol) {
    for (let j = 0; j + 1 < col.length; j++) {
      const i = col[j];
      if (!isLN(notes[i])) continue;
      totLn++;
      if (start[col[j + 1]] - end[i] < INVERSE_GAP_MS) inv++;
    }
  }
  s.ln_inverse = inv / Math.max(totLn, 1);
  if (lnIdx.length) {
    const starts = [...new Set(start.map(Math.round))].sort((a, b) => a - b);
    const near = (t: number) => {
      let lo = 0, hi = starts.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] < t) lo = m + 1; else hi = m; }
      return Math.min(Math.abs((starts[lo] ?? Infinity) - t), Math.abs((starts[lo - 1] ?? Infinity) - t));
    };
    s.ln_release_offgrid = mean(lnIdx.map((i) => +(near(Math.round(end[i])) > 3)));
    const step = Math.max(1, Math.floor(n / 2000));
    const held: number[] = [];
    for (let k = 0; k < n; k += step) {
      const t = start[k];
      held.push(lnIdx.filter((i) => start[i] < t - 1 && end[i] > t + 1).length);
    }
    s.ln_held_mean = mean(held) / K;
  } else {
    s.ln_release_offgrid = 0;
    s.ln_held_mean = 0;
  }

  // ---- effective scroll speed (BPM x SV relative to the main BPM)
  Object.assign(s, scrollStats(map, t0, t1, start, dur));
  return s;
}

function scrollStats(map: Beatmap, t0: number, t1: number, noteStarts: number[], dur: number): ChartStats {
  const reds = map.timingPoints.filter((t) => t.uninherited && t.beatLength > 0).sort((a, b) => a.time - b.time);
  const zero = { sv_log_std: 0, sv_stop_frac: 0, sv_far_frac: 0, sv_fast_frac: 0, sv_changes_near_notes_ps: 0 };
  if (!reds.length || t1 <= t0) return zero;
  const durBy = new Map<number, number>();
  reds.forEach((r, i) => {
    const nxt = i + 1 < reds.length ? reds[i + 1].time : t1;
    const k = Math.round(r.beatLength * 1000) / 1000;
    durBy.set(k, (durBy.get(k) ?? 0) + Math.max(Math.min(nxt, t1) - Math.max(r.time, t0), 0));
  });
  const main = [...durBy].sort((a, b) => b[1] - a[1])[0][0];
  const events = map.timingPoints
    .map((t) => ({ time: t.time, red: t.uninherited, v: t.uninherited ? t.beatLength : clip(-100 / t.beatLength, 0.01, 10) }))
    .filter((e) => (e.red ? e.v > 0 : Number.isFinite(e.v)))
    .sort((a, b) => a.time - b.time || Number(b.red) - Number(a.red));
  let bl = reds[0].beatLength;
  let sv = 1;
  let st: number[] = [];
  let sp: number[] = [];
  for (const e of events) {
    if (e.red) { bl = e.v; sv = 1; } else sv = e.v;
    st.push(e.time);
    sp.push((main / bl) * sv);
  }
  let first = 0;
  while (first + 1 < st.length && st[first + 1] <= t0) first++;
  st = st.slice(first);
  sp = sp.slice(first);
  st[0] = t0;
  const keep = st.map((t) => t < t1);
  st = st.filter((_, i) => keep[i]);
  sp = sp.filter((_, i) => keep[i]);
  const du = st.map((t, i) => Math.max((st[i + 1] ?? t1) - t, 0));
  const total = Math.max(du.reduce((a, b) => a + b, 0), 1);
  const w = du.map((d) => d / total);
  const logsp = sp.map((v) => Math.log(Math.max(v, 0.01)));
  const m = logsp.reduce((a, v, i) => a + w[i] * v, 0);
  const out: ChartStats = {
    sv_log_std: Math.sqrt(logsp.reduce((a, v, i) => a + w[i] * (v - m) ** 2, 0)),
    sv_far_frac: w.reduce((a, x, i) => a + (Math.abs(logsp[i]) > 0.4 ? x : 0), 0),
    sv_stop_frac: w.reduce((a, x, i) => a + (sp[i] < 0.2 ? x : 0), 0),
    sv_fast_frac: w.reduce((a, x, i) => a + (sp[i] > 2 ? x : 0), 0),
    sv_changes_near_notes_ps: 0,
  };
  let near = 0;
  for (let i = 1; i < st.length; i++) {
    if (Math.abs(logsp[i] - logsp[i - 1]) <= 0.05) continue;
    // nearest note start to this change
    let lo = 0, hi = noteStarts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (noteStarts[mid] < st[i]) lo = mid + 1; else hi = mid; }
    const idx = Math.min(lo, noteStarts.length - 1);
    if (Math.abs(noteStarts[idx] - st[i]) < 1500) near++;
  }
  out.sv_changes_near_notes_ps = near / dur;
  return out;
}

// ---------------------------------------------------------------- rule scores (0..1)

/** One score per osu! user tag; >= 0.5 means "the rule thinks this tag fits". */
export function tagScores(s: ChartStats): Record<string, number> {
  if (!s.notes) return {};
  const ln = sq(s.ln_ratio, 0.35, 0.05);
  const rice = 1 - ln;
  return {
    'style/jumpstream': rice * sq(s.jumpstream_row, 0.18, 0.04),
    'style/handstream': rice * sq(s.handstream_row, 0.10, 0.03),
    'style/chordstream': rice * sq(s.jumpstream_row + s.handstream_row, 0.25, 0.05),
    'style/quadstream': rice * sq(s.row_quad, 0.08, 0.03),
    'style/chordjack': rice * sq(s.chordjack_row, 0.15, 0.04),
    'skillset/speedjack': rice * sq(s.jack_row, 0.15, 0.04) * sq(-s.jack_gap_ms, -120, 15),
    'style/longjack': rice * sq(s.jack_chain3, 0.05, 0.02),
    'skillset/wristjack': rice * sq(s.jack_note, 0.25, 0.05),
    'skillset/streams': rice * sq(s.stream_row, 0.45, 0.08),
    'streams/speed': rice * sq(s.nps_per_key, 4.0, 0.6),
    'streams/stamina': sq(s.stamina * s.duration_s, 60, 15),
    'skillset/tech': sq(s.rhythm_variety + s.gap_ratio_change, 3.5, 0.8),
    'style/LN density': ln * sq(s.ln_count_ps, 6, 1.5),
    'style/LN release': ln * sq(s.ln_release_offgrid, 0.5, 0.1),
    'style/LN coordination': ln * sq(s.ln_held_mean, 0.35, 0.08),
    'gimmick/LN inverse': ln * sq(s.ln_inverse, 0.6, 0.1),
    'style/generic hybrid': clip(1 - Math.abs(s.ln_ratio - 0.25) / 0.15, 0, 1),
    'sliders/complex sv': sq(s.sv_changes_near_notes_ps, 0.5, 0.15) * sq(s.sv_log_std, 0.2, 0.05),
    'sliders/low sv': sq(s.sv_stop_frac + (s.sv_fast_frac < 0.05 ? s.sv_far_frac : 0), 0.15, 0.05),
    'sliders/high sv': sq(s.sv_fast_frac, 0.1, 0.04),
  };
}

export type Slot = 'RC' | 'LN' | 'HB' | 'SV';

/** Tournament mappool slot by hand rules (RC rice, LN, HB hybrid, SV). */
export function slotScores(s: ChartStats): Record<Slot, number> {
  const ln = s.ln_ratio ?? 0;
  return {
    SV: Math.min(1, (s.sv_log_std ?? 0) / 0.3) * Math.min(1, (s.sv_changes_near_notes_ps ?? 0) / 0.5),
    LN: clip((ln - 0.3) / 0.3, 0, 1),
    HB: clip(1 - Math.abs(ln - 0.25) / 0.15, 0, 1),
    RC: clip(1 - ln / 0.12, 0, 1),
  };
}

export function ruleSlot(s: ChartStats): Slot {
  const sc = slotScores(s);
  if (sc.SV >= 0.5) return 'SV';
  return (['RC', 'HB', 'LN'] as Slot[]).reduce((a, b) => (sc[b] > sc[a] ? b : a));
}

/** Tournament-style categories (several can apply), built from the tag rules. */
export function categoryScores(s: ChartStats): Record<string, number> {
  const h = tagScores(s);
  if (!s.notes) return {};
  return {
    Chordjack: h['style/chordjack'],
    Streams: h['skillset/streams'],
    'Jumpstream/Handstream': Math.max(h['style/jumpstream'], h['style/handstream'], h['style/chordstream']),
    Technical: h['skillset/tech'],
    Stamina: h['streams/stamina'],
    Release: h['style/LN release'],
    Coordination: h['style/LN coordination'],
    'Density/Inverse': Math.max(h['style/LN density'], h['gimmick/LN inverse']),
    Reading: h['sliders/complex sv'],
    TB: sq(s.duration_s, 200, 25) * sq(s.nps, 12, 3),
  };
}
