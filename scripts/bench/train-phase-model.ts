/**
 * Train the half-beat choice of the beat grid: with the ranked BPM given, is the ranked grid at
 * beatPhase() or half a beat away? Logistic regression on the difference of phaseFeatures() of
 * the two phases (no intercept: the choice is symmetric). Split by beatmap set id (% 3 == 0 held
 * out). Writes PHASE_MODEL into src/automap/tempomodel.ts (keeps TEMPO_MODEL).
 *
 *   npx tsx scripts/bench/train-phase-model.ts DATA_DIR [DATA_DIR...] [--cache f.json] [--dry]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze, beatPhase, detectOnsets, phaseFeatures, PHASE_FEATURES, ONSET_LATENCY, MAP_LEAD_MS } from '../../src/automap/analysis';

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--cache', '--synth-weight'].includes(argv[i - 1])));
const cache = opt('cache');
// weight of the synthetic tracks against the ranked songs (--synth-weight, default 0.15)
const synthWeight = Number(opt('synth-weight') ?? 0.15);
const F = PHASE_FEATURES.length;

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

interface Ex { id: number; d: number[]; y: number } // d = features(current) - features(half beat away); y = 1 if current is right
let ex: Ex[] = [];
if (cache && existsSync(cache)) ex = JSON.parse(readFileSync(cache, 'utf8'));
else {
  const seen = new Set<number>();
  for (const dir of dirs) for (const set of readdirSync(dir).sort()) {
    const p = join(dir, set);
    if (!statSync(p).isDirectory()) continue;
    const id = Number(set.split(' ')[0]);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    const files = readdirSync(p), audio = files.find((f) => /^audio\./.test(f));
    if (!audio) continue;
    const maps = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(p, f), 'utf8')); } catch { return null; } }).filter((m): m is Beatmap => !!m && m.notes.length > 50);
    if (!maps.length || maps.some((m) => redLines(m).length !== 1)) continue;
    const red = redLines(maps[0])[0];
    if (maps.some((m) => Math.abs(redLines(m)[0].time - red.time) > 2 || Math.abs(redLines(m)[0].beatLength - red.beatLength) > 0.5)) continue;
    seen.add(id);
    try {
      const a = analyze(decode(join(p, audio)), 22050);
      const bpm = 60000 / red.beatLength, fps = 1 / a.frameDur, period = (60 / bpm) * fps;
      const ph = beatPhase(a, bpm), alt = (ph + period / 2) % period;
      const err = (phase: number) => { const off = (phase / fps + ONSET_LATENCY(a)) * 1000, b = red.beatLength, d = (((off - red.time) % b) + b) % b; return Math.min(d, b - d); };
      const ec = err(ph), ea = err(alt);
      // only songs where one of the two is close (within 1/8 beat); the rest are other errors
      if (Math.min(ec, ea) > red.beatLength / 8) continue;
      const on = detectOnsets(a, 0.5);
      const fa = phaseFeatures(a, bpm, ph, on), fb = phaseFeatures(a, bpm, alt, on);
      ex.push({ id, d: fa.map((v, i) => v - fb[i]), y: ec <= ea ? 1 : 0 });
      if (ex.length % 25 === 0) console.log(`${ex.length} songs...`);
    } catch (e) { console.log(`skipped ${set}: ${(e as Error).message}`); }
  }
  if (cache) writeFileSync(cache, JSON.stringify(ex));
}

// synthetic drum tracks (kick + hat clicks, kick/snare/hat, half-time) at tempos and offsets the
// tests do not use, so the clean "kick on the beat, hat between" case is in the training data
function synth(bpm: number, offsetMs: number, style: 'click' | 'drums' | 'halftime', seconds = 30, sr = 22050): Float32Array {
  const out = new Float32Array(seconds * sr), beat = 60 / bpm;
  let rnd = Math.round(bpm * 7 + offsetMs);
  const noise = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (t: number, len: number, f: (x: number) => number) => { const s0 = Math.floor(t * sr); for (let i = 0; i < len * sr && s0 + i < out.length; i++) out[s0 + i] += f(i / sr); };
  const kick = (t: number, amp: number) => add(t, 0.3, (x) => Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-x * 30)) * x) * Math.exp(-x * 25) * amp);
  const snare = (t: number) => add(t, 0.2, (x) => (noise() * 0.6 + Math.sin(2 * Math.PI * 190 * x) * 0.4) * Math.exp(-x * 22) * 0.6);
  const hat = (t: number) => add(t, 0.04, (x) => noise() * 0.3 * Math.exp(-x * 80));
  for (let b = 0; offsetMs / 1000 + b * beat < seconds; b++) {
    const t = offsetMs / 1000 + b * beat, inBar = b % 4;
    if (style === 'click') kick(t, inBar === 0 ? 0.9 : 0.6);
    else if (style === 'halftime') { if (inBar === 0) kick(t, 0.9); if (inBar === 2) snare(t); }
    else { if (inBar % 2 === 0) kick(t, 0.9); else snare(t); }
    hat(t + beat / 2);
  }
  return out;
}
if (!ex.some((e) => e.id < 0)) {
  let sid = -1;
  for (const bpm of [96, 118, 132, 144, 166, 178, 192, 208, 226]) for (const style of ['click', 'drums', 'halftime'] as const) for (const off of [77, 191, 412]) {
    const a = analyze(synth(bpm, off, style), 22050);
    const fps = 1 / a.frameDur, period = (60 / bpm) * fps, beatMs = 60000 / bpm;
    const ph = beatPhase(a, bpm), alt = (ph + period / 2) % period;
    const truth = off - MAP_LEAD_MS;
    const err = (phase: number) => { const o = (phase / fps + ONSET_LATENCY(a)) * 1000, d = (((o - truth) % beatMs) + beatMs) % beatMs; return Math.min(d, beatMs - d); };
    const on = detectOnsets(a, 0.5);
    const fa = phaseFeatures(a, bpm, ph, on), fb = phaseFeatures(a, bpm, alt, on);
    // negative ids: synthetic, always training data
    ex.push({ id: sid--, d: fa.map((v, i) => v - fb[i]), y: err(ph) <= err(alt) ? 1 : 0 });
  }
  if (cache) writeFileSync(cache, JSON.stringify(ex));
  console.log(`added ${-sid - 1} synthetic tracks`);
}

const train = ex.filter((e) => e.id < 0 || e.id % 3 !== 0), test = ex.filter((e) => e.id >= 0 && e.id % 3 === 0);
const realTrain = train.filter((e) => e.id >= 0);
const std = Array.from({ length: F }, (_, j) => PHASE_FEATURES[j] === 'bias' ? 0 : Math.sqrt(realTrain.reduce((s, e) => s + e.d[j] ** 2, 0) / Math.max(1, realTrain.length)));
const z = (d: number[]) => d.map((v, j) => (std[j] > 0 ? v / std[j] : 0));
const w = new Array(F).fill(0);
for (let it = 0; it < 4000; it++) {
  const g = new Array(F).fill(0);
  let wsum = 0;
  for (const e of train) { const k = e.id < 0 ? synthWeight : 1; wsum += k; const x = z(e.d), p = 1 / (1 + Math.exp(-x.reduce((s, v, j) => s + v * w[j], 0))); for (let j = 0; j < F; j++) g[j] += k * (p - e.y) * x[j]; }
  for (let j = 0; j < F; j++) w[j] -= 0.2 * (g[j] / Math.max(1, wsum) + 0.01 * w[j]);
}
const acc = (set: Ex[], f: (e: Ex) => number) => set.filter((e) => f(e) === e.y).length;
const model = (e: Ex) => (z(e.d).reduce((s, v, j) => s + v * w[j], 0) >= 0 ? 1 : 0);
for (const [name, set] of [['train (ranked)', train.filter((e) => e.id >= 0)], ['train (synthetic)', train.filter((e) => e.id < 0)], ['test (held out)', test]] as const) {
  console.log(`${name}: ${set.length} songs; beatPhase right ${acc(set, () => 1)} (${(100 * acc(set, () => 1) / set.length).toFixed(0)}%), model right ${acc(set, model)} (${(100 * acc(set, model) / set.length).toFixed(0)}%)`);
}
console.log('weights:', PHASE_FEATURES.map((n, j) => `${n} ${w[j].toFixed(2)}`).join(', '));
if (!argv.includes('--dry')) {
  const note = `half-beat choice; held-out ${test.length} songs: right ${acc(test, () => 1)} -> ${acc(test, model)} (beatPhase -> model)`;
  const p = 'src/automap/tempomodel.ts';
  const s = readFileSync(p, 'utf8').replace(/export const PHASE_MODEL[^\n]*\n/, `export const PHASE_MODEL: { w: number[]; std: number[]; note: string } | null = ${JSON.stringify({ w: w.map((v) => +v.toFixed(5)), std: std.map((v) => +v.toFixed(6)), note })};\n`);
  writeFileSync(p, s);
  console.log(`wrote PHASE_MODEL (${note})`);
}
