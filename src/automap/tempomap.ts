/**
 * Tempo changes: a song's timing as several red lines.
 *
 * The song is cut into overlapping 16 s windows (4 s apart). In each one the learned tempo model
 * finds the local BPM (folded to the octave of the whole-song BPM) and the beat phase. Consecutive
 * windows that agree form a section; a new section starts where two windows in a row agree on a
 * different BPM, or on the same BPM with the beat moved (a skipped or added beat). Each section
 * gets its own BPM and offset, and the red line between two sections goes on the beat that fits
 * the onsets on both sides best. Songs whose windows all agree keep the single whole-song estimate.
 */
import type { Analysis } from './analysis';
import type { TimingPoint } from '../core/beatmap';
import { estimateTempo, phaseOffset, detectOnsets, ONSET_LATENCY } from './analysis';

export interface RedLine { time: number; beatLength: number }

/** detect tempo changes (otherwise one constant BPM is used); set from the tuned benchmark */
export const TEMPO_CHANGES = true;

/** osu! red lines for a detected timing */
export function toTimingPoints(lines: RedLine[]): TimingPoint[] {
  return lines.map((l) => ({ time: Math.round(l.time), beatLength: l.beatLength, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 100, uninherited: true, effects: 0 }));
}

/** the song's timing: tempo changes when TEMPO_CHANGES is on and they are clear, else one BPM */
export function detectTiming(a: Analysis): RedLine[] {
  if (TEMPO_CHANGES) return estimateTiming(a);
  const t = estimateTempo(a);
  return [{ time: t.offset, beatLength: 60000 / t.bpm }];
}

const WINDOW_MS = 16000, HOP_MS = 4000;
/** shorter songs and clips always get one BPM; sections shorter than this are merged away */
const MIN_SONG_MS = 60000, MIN_SECTION_MS = 12000;
/** how much better (relative) the sections must fit the onsets than one BPM to be kept */
export let SPLIT_GAIN = 0.08;
/** a section with the same BPM starts only where the beat moved by more than this (ms) */
export let SHIFT_MS = 40;
export function _setTempoMapParams(gain: number, shift: number) { SPLIT_GAIN = gain; SHIFT_MS = shift; }
/** BPMs within this ratio are the same tempo */
const SAME = 0.015;

/** the part of an analysis between t0 and t1 (ms); times inside it start at 0 */
export function sliceAnalysis(a: Analysis, t0: number, t1: number): Analysis {
  const f0 = Math.max(0, Math.floor(t0 / 1000 / a.frameDur)), f1 = Math.min(a.flux.length, Math.ceil(t1 / 1000 / a.frameDur));
  const s = (x: Float32Array) => x.subarray(f0, f1);
  return {
    ...a, flux: s(a.flux), rms: s(a.rms), centroid: s(a.centroid), bands: [s(a.bands[0]), s(a.bands[1]), s(a.bands[2])],
    flatness: a.flatness ? s(a.flatness) : undefined, pan: a.pan ? s(a.pan) : undefined, durationMs: (f1 - f0) * a.frameDur * 1000,
  };
}

const fold = (bpm: number, ref: number) => { let b = bpm; while (b > ref * 1.42) b /= 2; while (b < ref / 1.42) b *= 2; return b; };
const same = (x: number, y: number) => Math.abs(x / y - 1) <= SAME;

/** how well a grid (beat `beatMs`, a beat at `anchor`) fits the onset envelope between t0 and t1, at 1/2-beat resolution */
function gridFit(a: Analysis, anchor: number, beatMs: number, t0: number, t1: number): number {
  const env = a.flux, lat = ONSET_LATENCY(a) * 1000;
  let s = 0, n = 0;
  const k0 = Math.ceil((t0 - anchor) / (beatMs / 2)), k1 = Math.floor((t1 - anchor) / (beatMs / 2));
  for (let k = k0; k <= k1; k++) {
    const t = anchor + (k * beatMs) / 2, f = Math.round((t - lat) / 1000 / a.frameDur);
    let m = 0;
    for (let j = f - 1; j <= f + 1; j++) if (j >= 0 && j < env.length && env[j] > m) m = env[j];
    s += k % 2 === 0 ? m : 0.5 * m; n++;
  }
  return n ? s / n : 0;
}

interface Win { t0: number; t1: number; bpm: number; offset: number }

export function estimateTiming(a: Analysis): RedLine[] {
  const whole = estimateTempo(a);
  const single: RedLine[] = [{ time: whole.offset, beatLength: 60000 / whole.bpm }];
  const dur = a.durationMs;
  if (dur < MIN_SONG_MS) return single;
  // local tempo and phase per window
  const wins: Win[] = [];
  for (let t0 = 0; t0 + WINDOW_MS / 2 < dur; t0 += HOP_MS) {
    const t1 = Math.min(dur, t0 + WINDOW_MS);
    if (t1 - t0 < WINDOW_MS / 2) break;
    const sub = sliceAnalysis(a, t0, t1);
    let loud = 0; for (const v of sub.rms) loud += v;
    if (loud / Math.max(1, sub.rms.length) < 0.02) continue; // silence
    const local = estimateTempo(sub);
    const bpm = fold(local.bpm, whole.bpm);
    const off = t0 + phaseOffset(sub, bpm, 'model').offsetMs;
    wins.push({ t0, t1, bpm, offset: off });
  }
  if (wins.length < 3) return single;
  // sections: a new one starts where two windows in a row disagree with the current section
  const beatShift = (w: Win, bpm: number, anchor: number) => { const b = 60000 / bpm, d = (((w.offset - anchor) % b) + b) % b; return Math.min(d, b - d); };
  const sections: { wins: Win[]; bpm: number; anchor: number }[] = [{ wins: [wins[0]], bpm: wins[0].bpm, anchor: wins[0].offset }];
  for (let i = 1; i < wins.length; i++) {
    const cur = sections[sections.length - 1], w = wins[i], nx = wins[i + 1];
    const differs = (x: Win) => !same(x.bpm, cur.bpm) || beatShift(x, cur.bpm, cur.anchor) > SHIFT_MS;
    if (differs(w) && nx && differs(nx) && same(w.bpm, nx.bpm) && beatShift(nx, w.bpm, w.offset) <= SHIFT_MS) sections.push({ wins: [w], bpm: w.bpm, anchor: w.offset });
    else if (!differs(w) || !nx) cur.wins.push(w);
  }
  if (sections.length === 1) return single;
  // each section: BPM and offset from its whole span
  const spans = sections.map((s, k) => {
    const t0 = k === 0 ? 0 : s.wins[0].t0, t1 = k === sections.length - 1 ? dur : s.wins[s.wins.length - 1].t1;
    const sub = sliceAnalysis(a, t0, t1);
    const local = estimateTempo(sub);
    const bpm = fold(local.bpm, s.bpm);
    const useBpm = same(bpm, s.bpm) ? bpm : s.bpm;
    return { t0, t1, beatMs: 60000 / useBpm, anchor: t0 + phaseOffset(sub, useBpm, 'model').offsetMs };
  });
  // boundaries: the beat of the next section that best splits the two grids, near the windows' change
  const lines: RedLine[] = [];
  let start = spans[0];
  lines.push({ time: start.anchor - Math.floor((start.anchor - 0) / start.beatMs) * start.beatMs, beatLength: start.beatMs });
  for (let k = 1; k < spans.length; k++) {
    const prev = spans[k - 1], next = spans[k];
    const guess = (sections[k - 1].wins[sections[k - 1].wins.length - 1].t1 + sections[k].wins[0].t0) / 2;
    let best = { t: guess, s: -Infinity };
    for (let n = Math.ceil((guess - 6000 - next.anchor) / next.beatMs); next.anchor + n * next.beatMs <= guess + 6000; n++) {
      const t = next.anchor + n * next.beatMs;
      if (t <= lines[lines.length - 1].time + prev.beatMs * 4) continue;
      const s = gridFit(a, prev.anchor, prev.beatMs, t - 6000, t) + gridFit(a, t, next.beatMs, t, t + 6000);
      if (s > best.s) best = { t, s };
    }
    // the same tempo and the same beat as before: no red line needed
    const last = lines[lines.length - 1];
    if (same(last.beatLength, next.beatMs) && Math.abs(((best.t - last.time) / last.beatLength) - Math.round((best.t - last.time) / last.beatLength)) * last.beatLength < 10) continue;
    lines.push({ time: Math.round(best.t), beatLength: next.beatMs });
    start = next;
  }
  if (lines.length < 2) return single;
  // a section must last MIN_SECTION_MS: a shorter one is a misread window, not a tempo change
  for (let k = lines.length - 1; k >= 0; k--) {
    const end = k + 1 < lines.length ? lines[k + 1].time : dur;
    if (end - Math.max(0, lines[k].time) < MIN_SECTION_MS) lines.splice(k === 0 ? 1 : k, 1);
    if (lines.length < 2) return single;
  }
  // keep the sections only if they fit the onsets clearly better than one BPM over the whole song
  return timingFit(a, lines, dur) > timingFit(a, single, dur) * (1 + SPLIT_GAIN) ? lines : single;
}

/** mean grid fit of a timing over 0..dur, each red line over its own span */
export function timingFit(a: Analysis, lines: RedLine[], dur: number): number {
  const ls = [...lines].sort((x, y) => x.time - y.time);
  let s = 0, total = 0;
  ls.forEach((l, i) => {
    const t0 = i === 0 ? 0 : l.time, t1 = i + 1 < ls.length ? ls[i + 1].time : dur;
    if (t1 <= t0) return;
    s += gridFit(a, l.time, l.beatLength, t0, t1) * (t1 - t0); total += t1 - t0;
  });
  return total ? s / total : 0;
}


// ---------------------------------------------------------------- v2: tempo path over windows

/** cost of switching tempo between two windows, in units of the alignment score (tuned) */
export let SWITCH_PENALTY = 0.25;
export function _setSwitchPenalty(p: number) { SWITCH_PENALTY = p; }

/**
 * How well a tempo explains the onsets in [t0, t1): the strength-weighted share of onsets within
 * 15 ms of its half-beat grid at the best phase, minus the share a random grid would get. Also
 * returns that phase (ms, a beat of the grid).
 */
export function alignment(onsets: { time: number; strength: number }[], bpm: number, t0: number, t1: number): { score: number; anchor: number } {
  const half = 30000 / bpm, bins = Math.max(8, Math.round(half / 2));
  const hist = new Float64Array(bins);
  let total = 0;
  for (const o of onsets) {
    if (o.time < t0 || o.time >= t1) continue;
    const ph = (((o.time % half) + half) % half) / half;
    hist[Math.floor(ph * bins) % bins] += o.strength;
    total += o.strength;
  }
  if (total <= 0) return { score: 0, anchor: t0 };
  const w = Math.max(1, Math.round((15 / half) * bins));
  let best = -1, bi = 0;
  for (let b = 0; b < bins; b++) { let s = 0; for (let d = -w; d <= w; d++) s += hist[(b + d + bins) % bins]; if (s > best) { best = s; bi = b; } }
  const chance = Math.min(1, (2 * w + 1) / bins);
  return { score: best / total - chance, anchor: ((bi + 0.5) / bins) * half };
}

export function estimateTimingViterbi(a: Analysis): RedLine[] {
  const whole = estimateTempo(a);
  const single: RedLine[] = [{ time: whole.offset, beatLength: 60000 / whole.bpm }];
  const dur = a.durationMs;
  if (dur < WINDOW_MS * 2) return single;
  const onsets = detectOnsets(a, 0.6);
  // window tempos (octave-folded to the whole song), clustered into candidate tempos
  const starts: number[] = [];
  for (let t0 = 0; t0 + WINDOW_MS / 2 < dur; t0 += HOP_MS) starts.push(t0);
  const local = starts.map((t0) => fold(estimateTempo(sliceAnalysis(a, t0, Math.min(dur, t0 + WINDOW_MS))).bpm, whole.bpm));
  const cands: number[] = [whole.bpm];
  for (const b of [...local].sort((x, y) => x - y)) {
    const support = local.filter((x) => same(x, b)).length;
    if (support >= 2 && !cands.some((c) => same(c, b))) cands.push(local.filter((x) => same(x, b)).sort((x, y) => x - y)[support >> 1]);
  }
  if (cands.length === 1) return single;
  // alignment of every candidate in every window, then the best path with a cost per switch
  const A = starts.map((t0) => cands.map((c) => alignment(onsets, c, t0, Math.min(dur, t0 + WINDOW_MS)).score));
  const W = starts.length, C = cands.length;
  const score = A.map(() => new Float64Array(C)), from = A.map(() => new Int32Array(C));
  for (let c = 0; c < C; c++) score[0][c] = A[0][c];
  for (let w = 1; w < W; w++) for (let c = 0; c < C; c++) {
    let best = -Infinity, bi = 0;
    for (let p = 0; p < C; p++) { const v = score[w - 1][p] - (p === c ? 0 : SWITCH_PENALTY); if (v > best) { best = v; bi = p; } }
    score[w][c] = best + A[w][c]; from[w][c] = bi;
  }
  let c = 0;
  for (let k = 1; k < C; k++) if (score[W - 1][k] > score[W - 1][c]) c = k;
  const path = new Array<number>(W);
  for (let w = W - 1; w >= 0; w--) { path[w] = c; c = from[w][c]; }
  // sections from the path (window centres decide where they meet)
  const secs: { bpm: number; t0: number; t1: number }[] = [];
  for (let w = 0; w < W; w++) {
    const mid = starts[w] + WINDOW_MS / 2;
    if (!secs.length || !same(secs[secs.length - 1].bpm, cands[path[w]])) secs.push({ bpm: cands[path[w]], t0: secs.length ? mid - HOP_MS / 2 : 0, t1: dur });
    if (secs.length > 1) secs[secs.length - 2].t1 = Math.min(secs[secs.length - 2].t1, secs[secs.length - 1].t0);
  }
  if (secs.length === 1) return single;
  // each section: refined BPM and offset over its span; red lines on the best splitting beat
  const spans = secs.map((sec) => {
    const sub = sliceAnalysis(a, sec.t0, sec.t1);
    const est = estimateTempo(sub);
    const bpm = same(fold(est.bpm, sec.bpm), sec.bpm) ? fold(est.bpm, sec.bpm) : sec.bpm;
    return { ...sec, beatMs: 60000 / bpm, anchor: sec.t0 + phaseOffset(sub, bpm, 'model').offsetMs };
  });
  const lines: RedLine[] = [{ time: spans[0].anchor - Math.floor(spans[0].anchor / spans[0].beatMs) * spans[0].beatMs, beatLength: spans[0].beatMs }];
  for (let k = 1; k < spans.length; k++) {
    const prev = spans[k - 1], next = spans[k], guess = next.t0;
    let best = { t: guess, s: -Infinity };
    for (let n = Math.ceil((guess - 6000 - next.anchor) / next.beatMs); next.anchor + n * next.beatMs <= guess + 6000; n++) {
      const t = next.anchor + n * next.beatMs;
      if (t <= lines[lines.length - 1].time + prev.beatMs * 4) continue;
      const s = gridFit(a, prev.anchor, prev.beatMs, t - 6000, t) + gridFit(a, t, next.beatMs, t, t + 6000);
      if (s > best.s) best = { t, s };
    }
    if (best.s === -Infinity) continue;
    lines.push({ time: Math.round(best.t), beatLength: next.beatMs });
  }
  return lines.length > 1 ? lines : single;
}
