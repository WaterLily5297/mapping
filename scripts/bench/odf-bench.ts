/**
 * Onset detection functions against ranked maps: which detector finds the sounds mappers map?
 *
 *   npx tsx scripts/bench/odf-bench.ts DATA_DIR [DATA_DIR...] [--songs 30]
 *
 * One STFT per song (1024-sample window, ~10 ms hop at 22.05 kHz, as analyze()), then several
 * onset envelopes from it:
 *   linear    maniamap today: log magnitude of every FFT bin, positive difference
 *   logbands  log magnitude of a log-spaced filterbank (12 bands per octave, 30 Hz - 11 kHz)
 *   superflux logbands with a 3-band maximum filter on the previous frame and a 2-frame lag
 *             (Boeck & Widmer 2013: vibrato and tremolo stop counting as onsets)
 *   percussive the percussive part of a harmonic/percussive split (median filters over time and
 *             frequency, Fitzgerald 2010), then logbands flux
 *   combo     superflux + percussive
 * Each is peak-picked like detectOnsets at the threshold whose onset count matches the mapped
 * rows (all ranked difficulties of the song), after removing that detector's own median timing
 * bias. Prints precision / recall / F1 (25 ms) and the median timing error of the hits.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--songs'));
const nSongs = Number(opt('songs', '30'));
const SR = 22050, N = 1024, HOP = Math.round(SR * 0.005) * 2, BINS = N / 2, FD = HOP / SR;

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr; } }
  }
}
/** magnitude spectrogram, frames x bins */
function stft(x: Float32Array): Float32Array[] {
  const frames = Math.max(1, Math.floor((x.length - N) / HOP) + 1), win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const out: Float32Array[] = [], re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) { re[i] = (x[f * HOP + i] ?? 0) * win[i]; im[i] = 0; }
    fft(re, im);
    const m = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) m[k] = Math.hypot(re[k], im[k]);
    out.push(m);
  }
  return out;
}
/** triangular log-spaced filterbank: band -> [bin, weight][] */
function filterbank(perOctave = 12, fmin = 30, fmax = 11000): [number, number][][] {
  const centers: number[] = [];
  for (let f = fmin; f <= fmax; f *= 2 ** (1 / perOctave)) centers.push(f);
  const binOf = (f: number) => (f * N) / SR;
  const bands: [number, number][][] = [];
  for (let b = 1; b + 1 < centers.length; b++) {
    const lo = binOf(centers[b - 1]), c = binOf(centers[b]), hi = binOf(centers[b + 1]);
    const w: [number, number][] = [];
    for (let k = Math.max(1, Math.floor(lo)); k <= Math.min(BINS - 1, Math.ceil(hi)); k++) {
      const v = k <= c ? (k - lo) / Math.max(1e-9, c - lo) : (hi - k) / Math.max(1e-9, hi - c);
      if (v > 0) w.push([k, v]);
    }
    if (!w.length) w.push([Math.max(1, Math.min(BINS - 1, Math.round(c))), 1]);
    // merge duplicates at low frequencies (several bands on one bin)
    if (bands.length && bands[bands.length - 1].length === 1 && w.length === 1 && bands[bands.length - 1][0][0] === w[0][0]) continue;
    bands.push(w);
  }
  return bands;
}
const FB = filterbank();
const toBands = (S: Float32Array[]) => S.map((m) => Float32Array.from(FB, (w) => Math.log1p(100 * w.reduce((s, [k, v]) => s + m[k] * v, 0))));
const linearLog = (S: Float32Array[]) => S.map((m) => Float32Array.from(m, (v) => Math.log1p(100 * v)));
function flux(L: Float32Array[], lag = 1, maxFilter = 0): Float32Array {
  const out = new Float32Array(L.length);
  for (let f = lag; f < L.length; f++) {
    const cur = L[f], prev = L[f - lag];
    let s = 0;
    for (let k = 0; k < cur.length; k++) {
      let p = prev[k];
      for (let d = 1; d <= maxFilter; d++) p = Math.max(p, prev[k - d] ?? -Infinity, prev[k + d] ?? -Infinity);
      const d = cur[k] - p;
      if (d > 0) s += d;
    }
    out[f] = s;
  }
  return out;
}
/** percussive part (Fitzgerald median filtering, soft mask), as a magnitude spectrogram */
function percussive(S: Float32Array[], tLen = 17, fLen = 17): Float32Array[] {
  const F = S.length, K = BINS, med = (v: number[]) => { v.sort((a, b) => a - b); return v[v.length >> 1]; };
  const H = S.map(() => new Float32Array(K)), P = S.map(() => new Float32Array(K));
  for (let f = 0; f < F; f++) for (let k = 0; k < K; k += 1) {
    const ht: number[] = []; for (let d = -(tLen >> 1); d <= tLen >> 1; d++) { const g = S[f + d]; if (g) ht.push(g[k]); }
    H[f][k] = med(ht);
  }
  for (let f = 0; f < F; f++) { const row = S[f]; for (let k = 0; k < K; k++) { const v: number[] = []; for (let d = -(fLen >> 1); d <= fLen >> 1; d++) if (k + d >= 0 && k + d < K) v.push(row[k + d]); P[f][k] = med(v); } }
  return S.map((m, f) => Float32Array.from(m, (v, k) => { const h = H[f][k] ** 2, p = P[f][k] ** 2; return v * (h + p > 0 ? p / (h + p) : 0); }));
}
const norm = (a: Float32Array) => { let m = 0; for (const v of a) m = Math.max(m, v); return m > 0 ? Float32Array.from(a, (v) => v / m) : a; };

/** peak picking as detectOnsets, returning frame indices for a given delta */
function pick(f: Float32Array, delta: number): number[] {
  const w = 3, avgW = 20, minGap = 4, ps = new Float64Array(f.length + 1);
  for (let i = 0; i < f.length; i++) ps[i + 1] = ps[i] + f[i];
  const out: number[] = []; let last = -Infinity;
  for (let i = 0; i < f.length; i++) {
    const v = f[i]; let isMax = true;
    for (let j = Math.max(0, i - w); j <= Math.min(f.length - 1, i + w); j++) if (f[j] > v) { isMax = false; break; }
    if (!isMax) continue;
    const lo = Math.max(0, i - avgW), hi = Math.min(f.length, i + avgW + 1);
    if (v < (ps[hi] - ps[lo]) / (hi - lo) + delta || i - last < minGap) continue;
    last = i; out.push(i);
  }
  return out;
}
function pickCount(f: Float32Array, want: number): number[] {
  let lo = -0.05, hi = 0.5, best: number[] = [];
  for (let k = 0; k < 16; k++) { const d = (lo + hi) / 2, o = pick(f, d); if (!best.length || Math.abs(o.length - want) < Math.abs(best.length - want)) best = o; if (o.length > want) lo = d; else hi = d; }
  return best;
}
function match(a: number[], b: number[], tol = 25) {
  let i = 0, j = 0, hit = 0; const errs: number[] = [];
  while (i < a.length && j < b.length) { const d = a[i] - b[j]; if (Math.abs(d) <= tol) { hit++; errs.push(d); i++; j++; } else if (d < 0) i++; else j++; }
  return { hit, errs };
}

const NAMES = ['linear', 'logbands', 'superflux', 'percussive', 'combo'] as const;
const raw: Record<string, { rows: number[]; on: number[] }[]> = Object.fromEntries(NAMES.map((n) => [n, []]));
let songs = 0;
outer: for (const dir of dirs) for (const set of readdirSync(dir).sort()) {
  if (songs >= nSongs) break outer;
  const p = join(dir, set);
  if (!statSync(p).isDirectory()) continue;
  const files = readdirSync(p), audio = files.find((f) => /^audio\./.test(f));
  if (!audio) continue;
  const maps = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(p, f), 'utf8')); } catch { return null; } }).filter((m): m is Beatmap => !!m && m.notes.length > 100 && redLines(m).length >= 1);
  if (!maps.length) continue;
  songs++;
  const rows = [...new Set(maps.flatMap((m) => m.notes.map((n) => n.time)))].sort((a, b) => a - b);
  const x = decode(join(p, audio));
  const S = stft(x);
  const LB = toBands(S);
  const env: Record<string, Float32Array> = {
    linear: norm(flux(linearLog(S))),
    logbands: norm(flux(LB)),
    superflux: norm(flux(LB, 2, 1)),
    percussive: norm(flux(toBands(percussive(S)))),
  };
  env.combo = norm(Float32Array.from(env.superflux, (v, i) => v + env.percussive[i]));
  const t0 = rows[0] - 200, t1 = rows[rows.length - 1] + 200;
  for (const n of NAMES) {
    // frame -> ms at the start of the window; each detector's bias is removed below
    const on = pickCount(env[n], rows.length).map((f) => f * FD * 1000).filter((t) => t >= t0 - 100 && t <= t1 + 100);
    raw[n].push({ rows, on });
  }
  process.stdout.write(`\r${songs} songs`);
}
console.log('');
for (const n of NAMES) {
  // the detector's median timing offset to the mapped rows (within 80 ms), removed before scoring
  const ds: number[] = [];
  for (const { rows, on } of raw[n]) for (const t of on) { let lo = 0, hi = rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m] < t) lo = m + 1; else hi = m; } const c = [rows[lo - 1], rows[lo]].filter((v) => v !== undefined).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0]; if (c !== undefined && Math.abs(t - c) < 80) ds.push(t - c); }
  ds.sort((a, b) => a - b);
  const bias = ds[ds.length >> 1] ?? 0;
  let P = 0, R = 0; const errs: number[] = [];
  for (const { rows, on } of raw[n]) { const m = match(on.map((t) => t - bias), rows); P += m.hit / Math.max(1, on.length); R += m.hit / Math.max(1, rows.length); errs.push(...m.errs.map(Math.abs)); }
  P /= raw[n].length; R /= raw[n].length; errs.sort((a, b) => a - b);
  console.log(`${n.padEnd(11)} precision ${P.toFixed(3)} recall ${R.toFixed(3)} F1 ${(2 * P * R / (P + R)).toFixed(3)}  timing error median ${(errs[errs.length >> 1] ?? 0).toFixed(1)} ms  (bias ${bias.toFixed(0)} ms after window start)`);
}
