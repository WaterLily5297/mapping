/**
 * Audio analysis for the auto-mapper. Pure TypeScript, no dependencies, so it
 * runs both in the browser (after Web Audio decoding) and in Node (after
 * ffmpeg decoding). Input is mono PCM float samples.
 */

export interface Analysis {
  sampleRate: number;
  hop: number;
  /** seconds per frame */
  frameDur: number;
  /** onset strength (spectral flux) per frame, normalized 0..1 */
  flux: Float32Array;
  /** RMS loudness per frame, normalized 0..1 */
  rms: Float32Array;
  /** spectral centroid per frame, 0 (low) .. 1 (high) */
  centroid: Float32Array;
  /** low / mid / high band flux, normalized */
  bands: [Float32Array, Float32Array, Float32Array];
  durationMs: number;
  /** stereo position of the onsets per frame, -1 left .. 1 right (stereo input only, see withPan) */
  pan?: Float32Array;
  /** spectral flatness per frame, 0 (tonal: a voice, a synth, a chord) .. 1 (noise: hats, cymbals) */
  flatness?: Float32Array;
}

/** FFT window size; 1024 @ 22.05 kHz = 46 ms (good time resolution for rhythm games). */
export const WIN = 1024;
/** Where inside the window a flux peak shows up (calibrated on synthetic kicks/hats, see tests). */
export let LATENCY_FRAC = 0.72;
export function _setLatencyFrac(v: number) { LATENCY_FRAC = v; }

import { TEMPO_MODEL, PHASE_MODEL, type TempoModel } from './tempomodel';

// ---------------------------------------------------------------- FFT

function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function normalize(a: Float32Array): Float32Array {
  let max = 0;
  for (const v of a) if (v > max) max = v;
  if (max > 0) for (let i = 0; i < a.length; i++) a[i] /= max;
  return a;
}

// ---------------------------------------------------------------- analysis

export function analyze(samples: Float32Array, sampleRate: number, onProgress?: (p: number) => void): Analysis {
  const N = WIN;
  const hop = Math.round(sampleRate * 0.005) * 2; // ~10 ms hop
  const frames = Math.max(1, Math.floor((samples.length - N) / hop) + 1);
  const bins = N / 2;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const binHz = sampleRate / N;
  const lowEnd = Math.floor(200 / binHz);
  const midEnd = Math.floor(2500 / binHz);

  const flux = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const centroid = new Float32Array(frames);
  const flatness = new Float32Array(frames);
  const bands: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(frames), new Float32Array(frames), new Float32Array(frames),
  ];
  let prev = new Float64Array(bins);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const s = samples[off + i] ?? 0;
      energy += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(energy / N);
    fftInPlace(re, im);
    const mag = new Float64Array(bins);
    let num = 0;
    let den = 0;
    let fl = 0;
    let logSum = 0, linSum = 0;
    const bf = [0, 0, 0];
    for (let k = 1; k < bins; k++) {
      const mag0 = Math.hypot(re[k], im[k]) + 1e-9;
      logSum += Math.log(mag0); linSum += mag0;
      const m = Math.log1p(100 * mag0);
      mag[k] = m;
      num += k * m;
      den += m;
      const d = m - prev[k];
      if (d > 0) {
        fl += d;
        bf[k < lowEnd ? 0 : k < midEnd ? 1 : 2] += d;
      }
    }
    flux[f] = fl;
    bands[0][f] = bf[0];
    bands[1][f] = bf[1];
    bands[2][f] = bf[2];
    centroid[f] = den > 0 ? num / den / bins : 0;
    flatness[f] = linSum > 0 ? Math.exp(logSum / (bins - 1)) / (linSum / (bins - 1)) : 1;
    prev = mag;
    if (onProgress && f % 2000 === 0) onProgress(f / frames);
  }
  // centroid in log-ish scale for nicer spread
  for (let i = 0; i < frames; i++) centroid[i] = Math.min(1, Math.sqrt(centroid[i] * 2));
  normalize(flux);
  normalize(rms);
  bands.forEach(normalize);
  onProgress?.(1);
  return {
    sampleRate, hop, frameDur: hop / sampleRate, flux, rms, centroid, bands, flatness,
    durationMs: (samples.length / sampleRate) * 1000,
  };
}

/**
 * Stereo position of the onsets, per frame (same frames as analyze()): -1 = left, 0 = centre,
 * 1 = right. It is the balance of the two channels' spectral flux, so it follows where the new
 * sounds come from rather than the steady mix; frames without a clear onset lean to 0.
 */
export function stereoPan(left: Float32Array, right: Float32Array, sampleRate: number): Float32Array {
  const N = WIN, hop = Math.round(sampleRate * 0.005) * 2, bins = N / 2;
  const n = Math.min(left.length, right.length);
  const frames = Math.max(1, Math.floor((n - N) / hop) + 1);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const fluxOf = (x: Float32Array) => {
    const out = new Float32Array(frames);
    let prev = new Float64Array(bins);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      for (let i = 0; i < N; i++) { re[i] = (x[off + i] ?? 0) * win[i]; im[i] = 0; }
      fftInPlace(re, im);
      const mag = new Float64Array(bins);
      let fl = 0;
      for (let k = 1; k < bins; k++) { const m = Math.log1p(100 * Math.hypot(re[k], im[k])); mag[k] = m; const d = m - prev[k]; if (d > 0) fl += d; }
      out[f] = fl;
      prev = mag;
    }
    return out;
  };
  const fl = fluxOf(left), fr = fluxOf(right);
  let peak = 0;
  for (let f = 0; f < frames; f++) peak = Math.max(peak, fl[f] + fr[f]);
  const pan = new Float32Array(frames);
  // a floor of 5% of the loudest onset keeps quiet frames near the centre
  const floor = 0.05 * peak;
  for (let f = 0; f < frames; f++) pan[f] = (fr[f] - fl[f]) / (fl[f] + fr[f] + floor + 1e-9);
  return pan;
}

/** analysis of a stereo track: the mono mix's analysis plus the stereo position of its onsets */
export function analyzeStereo(left: Float32Array, right: Float32Array, sampleRate: number, onProgress?: (p: number) => void): Analysis {
  const n = Math.min(left.length, right.length);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (left[i] + right[i]) / 2;
  const a = analyze(mono, sampleRate, onProgress);
  a.pan = stereoPan(left, right, sampleRate);
  return a;
}

/**
 * How spread out the song's onsets are in the stereo field: the standard deviation of the pan at
 * the frames with the strongest onsets (top 20%). 0 for mono; ranked-map songs measure 0.04-0.06.
 */
export function stereoWidth(a: Analysis): number {
  if (!a.pan) return 0;
  const idx = [...a.flux.keys()].sort((x, y) => a.flux[y] - a.flux[x]).slice(0, Math.max(1, Math.floor(a.flux.length * 0.2)));
  const v = idx.map((i) => a.pan![i] ?? 0);
  const m = v.reduce((x, y) => x + y, 0) / v.length;
  return Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / v.length);
}

/** stereoWidth from which 'auto' sound direction follows the stereo position instead of pitch */
export const STEREO_WIDTH_AUTO = 0.1;

// ---------------------------------------------------------------- onsets

export interface Onset {
  time: number; // ms
  strength: number; // 0..1
  centroid: number; // 0..1
  frame: number;
}

/** Peak-pick the onset envelope with an adaptive (moving average) threshold. */
export function detectOnsets(a: Analysis, sensitivity = 0.5): Onset[] {
  const f = a.flux;
  const w = Math.max(1, Math.round(0.03 / a.frameDur)); // +-30 ms local max
  const avgW = Math.max(1, Math.round(0.2 / a.frameDur)); // 200 ms mean window
  const delta = 0.12 - 0.1 * sensitivity; // lower = more onsets
  const minGap = Math.round(0.035 / a.frameDur);
  const out: Onset[] = [];
  // prefix sums for moving average
  const ps = new Float64Array(f.length + 1);
  for (let i = 0; i < f.length; i++) ps[i + 1] = ps[i] + f[i];
  let last = -Infinity;
  for (let i = 0; i < f.length; i++) {
    const v = f[i];
    let isMax = true;
    for (let j = Math.max(0, i - w); j <= Math.min(f.length - 1, i + w); j++) {
      if (f[j] > v) { isMax = false; break; }
    }
    if (!isMax) continue;
    const lo = Math.max(0, i - avgW);
    const hi = Math.min(f.length, i + avgW + 1);
    const mean = (ps[hi] - ps[lo]) / (hi - lo);
    if (v < mean + delta) continue;
    if (i - last < minGap) continue;
    last = i;
    out.push({ time: (i * a.frameDur + ONSET_LATENCY(a)) * 1000, strength: v, centroid: a.centroid[i], frame: i });
  }
  return out;
}

// ---------------------------------------------------------------- tempo

export interface TempoEstimate {
  bpm: number;
  offset: number; // ms of the first downbeat-ish beat
  confidence: number;
}

function envAt(env: Float32Array, frame: number): number {
  const i = Math.floor(frame);
  const t = frame - i;
  if (i < 0 || i + 1 >= env.length) return 0;
  return env[i] * (1 - t) + env[i + 1] * t;
}

/**
 * Estimate a single constant BPM + offset.
 * 1. autocorrelation of the onset envelope for 70..250 BPM (with a mild prior near 150-180)
 * 2. fine comb search around the best candidate (0.01 BPM steps) with a phase sweep
 * Songs with tempo changes should be timed manually (the editor lets you add red lines).
 */
export function estimateTempoHeuristic(a: Analysis, minBpm = 70, maxBpm = 250): TempoEstimate {
  const fps = 1 / a.frameDur;
  const n = a.flux.length;
  // Beats are usually carried by kicks and snares: weight the low band up (same envelope as beatPhase).
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = 0.4 * a.flux[i] + 1.0 * a.bands[0][i] + 0.4 * a.bands[1][i];
  let mean = 0;
  for (const v of raw) mean += v;
  mean /= n || 1;
  const e = Float32Array.from(raw, (v) => Math.max(0, v - mean));
  // log-gaussian prior around 160 BPM (typical for rhythm game songs)
  const prior = (bpm: number) => Math.exp(-0.5 * (Math.log2(bpm / 160) / 0.9) ** 2);

  // 1. coarse: autocorrelation of the envelope
  const minLag = Math.floor((60 / maxBpm) * fps);
  const maxLag = Math.ceil((60 / minBpm) * fps);
  let bestLag = minLag;
  let bestScore = -Infinity;
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += e[i] * e[i + lag];
    s /= n - lag;
    const score = s * prior((60 * fps) / lag);
    scores.push(score);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  const coarse = (60 * fps) / bestLag;

  // Pulse envelope from the low + mid bands (kick and snare body): hi-hats and other bright
  // percussion live above ~2.5 kHz and cannot fake a faster beat.
  const pulseRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) pulseRaw[i] = a.bands[0][i] + a.bands[1][i];
  let lowMean = 0;
  for (const v of pulseRaw) lowMean += v;
  lowMean /= n || 1;
  const low = Float32Array.from(pulseRaw, (v) => Math.max(0, v - lowMean));

  /** best phase for a tempo on an envelope; returns mean strength on the grid, at its midpoints and at its 1/4 points */
  const grid = (env: Float32Array, bpm: number) => {
    const period = (60 / bpm) * fps;
    let best = { on: -Infinity, mid: 0, quarter: 0, phase: 0 };
    for (let ph = 0; ph < period; ph += 0.5) {
      let s = 0;
      let cnt = 0;
      for (let x = ph; x < n - 1; x += period) { s += envAt(env, x); cnt++; }
      s /= cnt || 1;
      if (s > best.on) best = { on: s, mid: 0, quarter: 0, phase: ph };
    }
    let m = 0, q = 0, cnt = 0;
    for (let x = best.phase; x + period < n - 1; x += period) {
      m += envAt(env, x + period / 2);
      q += (envAt(env, x + period / 4) + envAt(env, x + (3 * period) / 4)) / 2;
      cnt++;
    }
    best.mid = m / (cnt || 1);
    best.quarter = q / (cnt || 1);
    return best;
  };
  const refine = (env: Float32Array, c: number) => {
    let local = { bpm: c, score: -Infinity };
    for (let bpm = c - 2; bpm <= c + 2; bpm += 0.1) {
      const sc = grid(env, bpm).on;
      if (sc > local.score) local = { bpm, score: sc };
    }
    for (let bpm = local.bpm - 0.12; bpm <= local.bpm + 0.12; bpm += 0.01) {
      const sc = grid(env, bpm).on;
      if (sc > local.score) local = { bpm, score: sc };
    }
    return local;
  };

  // 2. metrical candidates: autocorrelation often locks onto 2/3, 3/4, 1/2... of the real tempo
  //    (syncopation, triplet feels). Score each related tempo by how strongly its beat grid
  //    lands on the kick/snare pulse, times the prior.
  const ratios = [1, 2 / 3, 3 / 2, 1 / 2, 2, 3 / 4, 4 / 3, 1 / 3, 1 / 4];
  let pick = { bpm: coarse, score: -Infinity };
  for (const r of ratios) {
    const c = coarse * r;
    // half-time drums pulse at half the tempo: allow candidates down to minBpm / 2 here,
    // the octave step below brings the result back into range
    if (c < minBpm / 2 || c > maxBpm) continue;
    const local = refine(low, c);
    const total = local.score * prior(local.bpm);
    if (total > pick.score) pick = { bpm: local.bpm, score: total };
  }

  // 3. octave: go up while
  //    - the grid's midpoints still carry kick/snare hits (a backbeat between the chosen beats), or
  //    - the song's most common fast note spacing would be 1/8 or faster at this tempo
  //      (mappers choose the BPM that makes streams 1/4, e.g. half-time drums under 1/4 melodies).
  const ioi = commonFastGap(a);
  for (let guard = 0; guard < 2 && pick.bpm * 2 <= maxBpm; guard++) {
    const gl = grid(low, pick.bpm);
    const backbeat = gl.on > 0 && gl.mid / gl.on >= 0.4;
    const quarterMs = 60000 / pick.bpm / 4;
    const tooDense = ioi > 0 && quarterMs >= ioi * 1.8;
    if (!backbeat && !tooDense) break;
    pick = { bpm: refine(low, pick.bpm * 2).bpm, score: pick.score };
  }
  while (pick.bpm < minBpm) pick = { bpm: refine(low, pick.bpm * 2).bpm, score: pick.score };

  // prefer "round" BPMs if they are almost as good (most songs are integer BPM)
  const rounded = Math.round(pick.bpm);
  const bpm = Math.abs(rounded - pick.bpm) < 0.15 ? rounded : Math.round(pick.bpm * 100) / 100;
  const offset = phaseOffset(a, bpm, PHASE_MODEL ? 'model' : 'refined').offsetMs;
  const sorted = [...scores].sort((x, y) => y - x);
  const confidence = sorted.length > 1 && sorted[0] > 0 ? 1 - sorted[Math.floor(sorted.length / 2)] / sorted[0] : 0;
  return { bpm, offset, confidence: Math.max(0, Math.min(1, confidence)) };
}

/** score of a tempo candidate under a model (higher = more likely the ranked BPM) */
export function tempoScore(m: TempoModel, x: number[]): number {
  let z = 0;
  for (let i = 0; i < x.length; i++) z += (m.w[i] ?? 0) * (m.std[i] > 0 ? (x[i] - m.mean[i]) / m.std[i] : x[i]);
  return z;
}

/**
 * Estimate one constant BPM and its offset: the learned tempo model picks among the heuristic's
 * candidates (when it is trained), then the beat phase is found for that BPM.
 */
export function estimateTempo(a: Analysis, minBpm = 70, maxBpm = 250, model: TempoModel | null = TEMPO_MODEL): TempoEstimate {
  if (!model) return estimateTempoHeuristic(a, minBpm, maxBpm);
  const { heuristic, cands } = tempoCandidates(a);
  if (!cands.length) return heuristic;
  const best = cands.reduce((x, y) => (tempoScore(model, y.x) > tempoScore(model, x.x) ? y : x));
  if (Math.abs(best.bpm / heuristic.bpm - 1) < 0.01) return heuristic;
  const rounded = Math.round(best.bpm);
  const bpm = Math.abs(rounded - best.bpm) < 0.15 ? rounded : Math.round(best.bpm * 100) / 100;
  const offset = phaseOffset(a, bpm, PHASE_MODEL ? 'model' : 'refined').offsetMs;
  return { bpm, offset, confidence: heuristic.confidence };
}

/** onset envelopes used by the tempo search */
function tempoEnvelopes(a: Analysis): { low: Float32Array; full: Float32Array } {
  const n = a.flux.length;
  const pulse = new Float32Array(n), raw = new Float32Array(n);
  let lm = 0, fm = 0;
  for (let i = 0; i < n; i++) { pulse[i] = a.bands[0][i] + a.bands[1][i]; raw[i] = a.flux[i]; lm += pulse[i]; fm += raw[i]; }
  lm /= n || 1; fm /= n || 1;
  return { low: Float32Array.from(pulse, (v) => Math.max(0, v - lm)), full: Float32Array.from(raw, (v) => Math.max(0, v - fm)) };
}

/** mean envelope on a grid of `period` frames at its best phase (0.5-frame steps), and that phase */
function gridStrength(env: Float32Array, period: number): { on: number; phase: number } {
  const n = env.length;
  let best = { on: -Infinity, phase: 0 };
  for (let ph = 0; ph < period; ph += 0.5) {
    let s = 0, cnt = 0;
    for (let x = ph; x < n - 1; x += period) { s += envAt(env, x); cnt++; }
    s /= cnt || 1;
    if (s > best.on) best = { on: s, phase: ph };
  }
  return best;
}

/** names of the tempo candidate features (see tempoCandidates) */
export const TEMPO_FEATURES = [
  'log2(bpm/160)', 'log2(bpm/160)^2', 'pulse on beats', 'pulse on 1/2', 'pulse on 1/4', 'flux on beats',
  'onsets on 1/1', 'onsets on 1/2', 'onsets on 1/4', 'onsets on 1/3', 'onsets on 1/6', 'common gap vs 1/4', 'common gap vs 1/3', 'heuristic pick', 'bias',
  'pulse 1/2 vs beats', 'pulse 1/4 vs beats',
];

/** the ratio features derived from the base ones (kept separate so cached feature sets can be extended) */
export function tempoDerived(x: number[]): number[] {
  const on = Math.max(1e-6, x[2]);
  return [...x.slice(0, 15), x[3] / on, x[4] / on];
}

export interface TempoCandidate { bpm: number; x: number[] }

/**
 * Tempo candidates for a song, with features: the heuristic's pick and its metrical relatives
 * (x2/3, x3/2, x1/2, x2, x3/4, x4/3), each refined to 0.01 BPM on the kick/snare pulse.
 * Features say how the pulse and the detected onsets sit on the candidate's beat grid and its
 * 1/2, 1/4, 1/3 and 1/6 subdivisions; a tempo at 2/3 of the real one puts the real beats on 1/3s.
 */
export function tempoCandidates(a: Analysis, minBpm = 60, maxBpm = 330): { heuristic: TempoEstimate; cands: TempoCandidate[] } {
  const heuristic = estimateTempoHeuristic(a);
  const fps = 1 / a.frameDur;
  const { low, full } = tempoEnvelopes(a);
  const lowMean = low.reduce((x, y) => x + y, 0) / Math.max(1, low.length) || 1;
  const fullMean = full.reduce((x, y) => x + y, 0) / Math.max(1, full.length) || 1;
  const refine = (c: number) => {
    let best = { bpm: c, on: -Infinity };
    for (let b = c * 0.99; b <= c * 1.01; b += c * 0.001) { const g = gridStrength(low, (60 / b) * fps).on; if (g > best.on) best = { bpm: b, on: g }; }
    for (let b = best.bpm - 0.1; b <= best.bpm + 0.1; b += 0.01) { const g = gridStrength(low, (60 / b) * fps).on; if (g > best.on) best = { bpm: b, on: g }; }
    return best.bpm;
  };
  const onsets = detectOnsets(a, 0.6);
  const wsum = onsets.reduce((x, o) => x + o.strength, 0) || 1;
  const ioi = commonFastGap(a);
  const bpms: number[] = [];
  for (const r of [1, 2 / 3, 3 / 2, 1 / 2, 2, 3 / 4, 4 / 3]) {
    const c = heuristic.bpm * r;
    if (c < minBpm || c > maxBpm) continue;
    const b = r === 1 ? heuristic.bpm : refine(c);
    if (!bpms.some((x) => Math.abs(x / b - 1) < 0.01)) bpms.push(b);
  }
  const cands = bpms.map((bpm) => {
    const period = (60 / bpm) * fps;
    const g = gridStrength(low, period);
    const half = (gridAt(low, g.phase + period / 2, period));
    const quarter = (gridAt(low, g.phase + period / 4, period) + gridAt(low, g.phase + (3 * period) / 4, period)) / 2;
    const gf = gridStrength(full, period).on;
    // onsets (strength-weighted) within 15 ms of each subdivision of this grid
    const beatMs = 60000 / bpm, phaseMs = (g.phase / fps) * 1000 + ONSET_LATENCY(a) * 1000;
    const share = (div: number) => {
      let s = 0;
      for (const o of onsets) {
        const pos = (((o.time - phaseMs) / beatMs) * div) % 1;
        const d = Math.min(pos < 0 ? pos + 1 : pos, 1 - (pos < 0 ? pos + 1 : pos)) * (beatMs / div);
        if (d <= 15) s += o.strength;
      }
      return s / wsum;
    };
    const lb = Math.log2(bpm / 160);
    const gapFit = (div: number) => (ioi > 0 ? Math.abs(Math.log2(beatMs / div / ioi)) : 1);
    const x = [
      lb, lb * lb, g.on / lowMean, half / lowMean, quarter / lowMean, gf / fullMean,
      share(1), share(2), share(4), share(3), share(6), gapFit(4), gapFit(3), Math.abs(bpm / heuristic.bpm - 1) < 0.01 ? 1 : 0, 1,
    ];
    return { bpm, x: tempoDerived(x) };
  });
  return { heuristic, cands };
}

/** mean envelope on a grid of `period` frames starting at `phase` */
function gridAt(env: Float32Array, phase: number, period: number): number {
  let s = 0, cnt = 0;
  for (let x = ((phase % period) + period) % period; x < env.length - 1; x += period) { s += envAt(env, x); cnt++; }
  return s / (cnt || 1);
}

/**
 * Most common spacing (ms) between consecutive onsets among fast ones (40..400 ms), if one
 * spacing clearly dominates (>= 25% of the gaps within +-8%); otherwise 0.
 */
function commonFastGap(a: Analysis): number {
  const on = detectOnsets(a, 1).map((o) => o.time); // max sensitivity: quiet melodies count
  const gaps: number[] = [];
  for (let i = 1; i < on.length; i++) {
    const g = on[i] - on[i - 1];
    if (g >= 40 && g <= 400) gaps.push(g);
  }
  if (gaps.length < 16) return 0;
  let best = 0;
  let bestCount = 0;
  for (const g of gaps) {
    const c = gaps.filter((x) => Math.abs(x - g) <= g * 0.08).length;
    if (c > bestCount) { bestCount = c; best = g; }
  }
  if (bestCount < gaps.length * 0.25) return 0;
  const near = gaps.filter((x) => Math.abs(x - best) <= best * 0.08);
  return near.reduce((x, y) => x + y, 0) / near.length;
}

/** Onsets are reported at the start of the analysis frame; this shifts them to the real attack. */
/**
 * How much earlier than the detected onset osu! mappers place the note, in ms. The detector is
 * exact on synthetic clicks (LATENCY_FRAC), but on 80 ranked songs (training split of
 * scripts/bench/audio-bench.ts) the mapped rows sat a median 24 ms before the detected onsets and
 * the ranked beat grid 26.5 ms before the detected one, with the same lead in the original mp3s:
 * mappers time to the start of the attack, which comes before the spectral-flux peak.
 */
export const MAP_LEAD_MS = 25;

/** seconds from a flux frame to the time a mapper would place its note */
export const ONSET_LATENCY = (a: Analysis): number => (LATENCY_FRAC * WIN) / a.sampleRate - MAP_LEAD_MS / 1000;

/**
 * Best beat phase (in frames) for a known BPM. Beats are usually carried by
 * kicks/snares, so the low band gets extra weight; this stops the phase from
 * locking onto off-beat hi-hats (which have the most broadband flux).
 */
export const PHASE_FEATURES = ['low band', 'mid band', 'high band', 'flux', 'loudness rise', 'onsets', 'strong onsets', 'bias'];

/**
 * Features of a beat-grid phase (frames): mean low / mid / high band flux, flux and loudness rise on
 * the grid, and how much onset strength sits within 15 ms of it (all, and the top third).
 * The half-beat choice compares a phase with the one half a beat away.
 */
export function phaseFeatures(a: Analysis, bpm: number, phase: number, onsets?: Onset[]): number[] {
  const fps = 1 / a.frameDur, period = (60 / bpm) * fps, beatMs = 60000 / bpm;
  const cnt = Math.max(1, Math.floor(a.flux.length / period));
  const rise = new Float32Array(a.rms.length);
  for (let i = 2; i < a.rms.length; i++) rise[i] = Math.max(0, a.rms[i] - a.rms[i - 2]);
  const on = onsets ?? detectOnsets(a, 0.5);
  const off = (phase / fps + ONSET_LATENCY(a)) * 1000;
  const sorted = [...on].map((o) => o.strength).sort((x, y) => y - x);
  const strongCut = sorted[Math.floor(sorted.length / 3)] ?? 0;
  let all = 0, strong = 0, tot = 0, totStrong = 0;
  for (const o of on) {
    const k = Math.round((o.time - off) / beatMs), d = Math.abs(o.time - (off + k * beatMs));
    tot += o.strength; if (o.strength >= strongCut) totStrong += o.strength;
    if (d <= 15) { all += o.strength; if (o.strength >= strongCut) strong += o.strength; }
  }
  return [
    gridSum(a.bands[0], phase, period) / cnt, gridSum(a.bands[1], phase, period) / cnt, gridSum(a.bands[2], phase, period) / cnt,
    gridSum(a.flux, phase, period) / cnt, gridSum(rise, phase, period) / cnt, all / Math.max(1e-9, tot), strong / Math.max(1e-9, totStrong), 1,
  ];
}

export const PHASE_VARIANTS = ['current', 'refined', 'kick', 'both', 'model'] as const;
export type PhaseVariant = typeof PHASE_VARIANTS[number];

/** sum of an envelope on a grid of `period` frames from `phase` */
function gridSum(env: Float32Array, phase: number, period: number): number {
  let s = 0;
  for (let x = ((phase % period) + period) % period; x < env.length; x += period) s += envAt(env, x);
  return s;
}

/**
 * Offset (ms) of the beat grid for a known BPM. 'current' is beatPhase(); 'kick' decides between
 * that phase and the one half a beat away by the low band (kicks and snares sit on beats, hats and
 * off-beat chords between them); 'refined' moves the grid by the strength-weighted median distance
 * of the detected onsets near its beats.
 */
export function phaseOffset(a: Analysis, bpm: number, variant: PhaseVariant = 'current'): { offsetMs: number } {
  const fps = 1 / a.frameDur, period = (60 / bpm) * fps, beatMs = 60000 / bpm;
  let ph = beatPhase(a, bpm);
  if (variant === 'model' && PHASE_MODEL) {
    // learned half-beat choice, then the onset refinement
    const alt = (ph + period / 2) % period;
    const fa = phaseFeatures(a, bpm, ph), fb = phaseFeatures(a, bpm, alt);
    const z = fa.reduce((s2, v, i) => s2 + PHASE_MODEL!.w[i] * (PHASE_MODEL!.std[i] > 0 ? (v - fb[i]) / PHASE_MODEL!.std[i] : 0), 0);
    if (z < 0) ph = alt;
  }
  if (variant === 'kick' || variant === 'both') {
    const alt = ph + period / 2;
    if (gridSum(a.bands[0], alt, period) > gridSum(a.bands[0], ph, period)) ph = alt % period;
  }
  let off = (ph / fps + ONSET_LATENCY(a)) * 1000;
  if (variant === 'refined' || variant === 'both' || variant === 'model') {
    const dev: { d: number; w: number }[] = [];
    for (const o of detectOnsets(a, 0.5)) {
      const k = Math.round((o.time - off) / beatMs), d = o.time - (off + k * beatMs);
      if (Math.abs(d) <= beatMs / 8) dev.push({ d, w: o.strength });
    }
    if (dev.length >= 8) {
      dev.sort((x, y) => x.d - y.d);
      const half = dev.reduce((x, y) => x + y.w, 0) / 2;
      let acc = 0;
      for (const v of dev) { acc += v.w; if (acc >= half) { off += v.d; break; } }
    }
  }
  return { offsetMs: Math.round(off) };
}

export function beatPhase(a: Analysis, bpm: number): number {
  const fps = 1 / a.frameDur;
  const period = (60 / bpm) * fps;
  const n = a.flux.length;
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = 0.4 * a.flux[i] + 1.0 * a.bands[0][i] + 0.4 * a.bands[1][i];
  let best = 0;
  let bestS = -Infinity;
  for (let ph = 0; ph < period; ph += 0.25) {
    let s = 0;
    for (let x = ph; x < n; x += period) s += envAt(env, x);
    if (s > bestS) { bestS = s; best = ph; }
  }
  return best;
}
