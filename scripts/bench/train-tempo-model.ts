/**
 * Train the tempo model: among each song's tempo candidates (analysis.ts tempoCandidates), which
 * one is the ranked map's BPM? Conditional logit (softmax over a song's candidates), trained on
 * songs whose beatmap set id % 3 != 0 and tested on the rest (an id split, so a song that sits in
 * several data folders cannot be on both sides). Writes src/automap/tempomodel.ts.
 *
 *   npx tsx scripts/bench/train-tempo-model.ts DATA_DIR [DATA_DIR...] [--cache f.json] [--dry]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze, tempoCandidates, tempoDerived, TEMPO_FEATURES } from '../../src/automap/analysis';

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--cache'));
const cache = opt('cache');
const F = TEMPO_FEATURES.length;

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

interface Song { id: number; name: string; ref: number; heuristic: number; cands: { bpm: number; x: number[]; y: number }[] }
let songs: Song[] = [];
if (cache && existsSync(cache)) songs = JSON.parse(readFileSync(cache, 'utf8'));
else {
  const seen = new Set<number>();
  for (const dir of dirs) for (const set of readdirSync(dir).sort()) {
    const p = join(dir, set);
    if (!statSync(p).isDirectory()) continue;
    const id = Number(set.split(' ')[0]);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    const files = readdirSync(p);
    const audio = files.find((f) => /^audio\./.test(f));
    if (!audio) continue;
    const maps = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(p, f), 'utf8')); } catch { return null; } })
      .filter((m): m is Beatmap => !!m && m.notes.length > 50);
    if (!maps.length || maps.some((m) => redLines(m).length !== 1)) continue;
    const beat = redLines(maps[0])[0].beatLength;
    if (maps.some((m) => Math.abs(redLines(m)[0].beatLength - beat) > 0.5)) continue;
    seen.add(id);
    const ref = 60000 / beat;
    try {
      const a = analyze(decode(join(p, audio)), 22050);
      const { heuristic, cands } = tempoCandidates(a);
      songs.push({ id, name: set.slice(0, 40), ref, heuristic: heuristic.bpm, cands: cands.map((c) => ({ bpm: c.bpm, x: c.x, y: Math.abs(c.bpm / ref - 1) < 0.005 ? 1 : 0 })) });
      if (songs.length % 25 === 0) console.log(`${songs.length} songs analysed...`);
    } catch (e) { console.log(`skipped ${set}: ${(e as Error).message}`); }
  }
  if (cache) writeFileSync(cache, JSON.stringify(songs));
}

// synthetic songs (kick/snare/hat, half-time and 2/3-trap melodies, at tempos and offsets the
// tests do not use) so clean, unambiguous drum tracks are in the training data too
function synthSong(bpm: number, offset: number, style: 'drums' | 'polymelody' | 'halftime', seconds = 30, sr = 22050): Float32Array {
  const out = new Float32Array(seconds * sr), beat = 60 / bpm;
  let seed = Math.round(bpm * 17 + offset * 3 + 5);
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (t: number, len: number, f: (x: number) => number) => { const s0 = Math.floor(t * sr); for (let i = 0; i < len * sr && s0 + i < out.length; i++) out[s0 + i] += f(i / sr); };
  const kick = (t: number) => add(t, 0.25, (x) => Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-x * 35)) * x) * Math.exp(-x * 14) * 0.9);
  const snare = (t: number) => add(t, 0.2, (x) => (rnd() * 0.6 + Math.sin(2 * Math.PI * 190 * x) * 0.4) * Math.exp(-x * 22) * 0.6);
  let h1 = 0, h2 = 0;
  const hp = () => { const v = rnd(); const d1 = v - h1; h1 = v; const d2 = d1 - h2; h2 = d1; return d2 / 4; };
  const hat = (t: number) => add(t, 0.05, (x) => hp() * Math.exp(-x * 90) * 0.5);
  const tone = (t: number, len: number, f: number, amp: number) => add(t, len, (x) => Math.sin(2 * Math.PI * f * x) * amp * Math.min(1, x * 200) * Math.min(1, (len - x) * 30));
  const scale = [261.6, 293.7, 329.6, 392, 440, 523.3, 587.3, 659.3];
  for (let b = 0; offset / 1000 + b * beat < seconds; b++) {
    const t = offset / 1000 + b * beat, inBar = b % 4;
    if (style === 'halftime') { if (inBar === 0) kick(t); if (inBar === 2) snare(t); } else { if (inBar === 0 || inBar === 2) kick(t); if (inBar === 1 || inBar === 3) snare(t); }
    hat(t + beat / 2);
    if (style === 'polymelody') for (let q = 0; q < 4; q++) if ((b * 4 + q) % 3 !== 2) tone(t + (q * beat) / 4, (beat / 4) * 0.9, scale[(b * 3 + q * 5) % 8], 0.25);
    if (style === 'halftime') for (let q = 0; q < 4; q++) tone(t + (q * beat) / 4, (beat / 4) * 0.9, scale[(b + q * 3) % 8], 0.2);
  }
  return out;
}
if (!songs.some((s) => s.id < 0)) {
  let sid = -1;
  for (const bpm of [96, 112, 124, 134, 146, 156, 168, 186, 194, 210, 230, 246]) for (const style of ['drums', 'polymelody', 'halftime'] as const) {
    if (style === 'halftime' && bpm > 210) continue;
    const off = 40 + ((bpm * 11) % 500);
    const { heuristic, cands } = tempoCandidates(analyze(synthSong(bpm, off, style), 22050));
    // negative ids: synthetic, always training data
    songs.push({ id: sid--, name: `synthetic ${bpm} ${style}`, ref: bpm, heuristic: heuristic.bpm, cands: cands.map((c) => ({ bpm: c.bpm, x: c.x, y: Math.abs(c.bpm / bpm - 1) < 0.005 ? 1 : 0 })) });
  }
  if (cache) writeFileSync(cache, JSON.stringify(songs));
  console.log(`added ${-sid - 1} synthetic songs`);
}

// cached feature sets from before new derived features were added
for (const s of songs) for (const c of s.cands) if (c.x.length < F) c.x = tempoDerived(c.x);
const isTest = (s: Song) => s.id >= 0 && s.id % 3 === 0;
const train = songs.filter((s) => !isTest(s)), test = songs.filter(isTest);
// standardise on the training candidates (bias stays 1)
const all = train.flatMap((s) => s.cands.map((c) => c.x));
const mean = Array.from({ length: F }, (_, j) => all.reduce((x, v) => x + v[j], 0) / all.length);
const std = Array.from({ length: F }, (_, j) => { const sd = Math.sqrt(all.reduce((x, v) => x + (v[j] - mean[j]) ** 2, 0) / all.length); return TEMPO_FEATURES[j] === 'bias' ? 0 : sd; });
const z = (x: number[]) => x.map((v, j) => (std[j] > 0 ? (v - mean[j]) / std[j] : v));

// conditional logit by gradient descent, L2 penalty
const w = new Array(F).fill(0);
const usable = train.filter((s) => s.cands.some((c) => c.y));
const lambda = 0.01, lr = 0.1;
for (let it = 0; it < 3000; it++) {
  const g = new Array(F).fill(0);
  for (const s of usable) {
    const zs = s.cands.map((c) => z(c.x));
    const sc = zs.map((x) => x.reduce((a, v, j) => a + v * w[j], 0));
    const m = Math.max(...sc), e = sc.map((v) => Math.exp(v - m)), sum = e.reduce((a, b) => a + b, 0);
    s.cands.forEach((c, i) => { const p = e[i] / sum; for (let j = 0; j < F; j++) g[j] += (p - c.y) * zs[i][j]; });
  }
  for (let j = 0; j < F; j++) w[j] -= lr * (g[j] / usable.length + lambda * w[j]);
}

const pick = (s: Song) => s.cands.reduce((a, b) => {
  const sc = (c: typeof a) => z(c.x).reduce((x, v, j) => x + v * w[j], 0);
  return sc(b) > sc(a) ? b : a;
});
/** model pick, but an octave of the heuristic's pick keeps the heuristic's octave (its backbeat / note-spacing rules) */
const pickHybrid = (s: Song) => { const p = pick(s); const r = p.bpm / s.heuristic; return Math.abs(r / 2 - 1) < 0.01 || Math.abs(r * 2 - 1) < 0.01 ? { bpm: s.heuristic } : p; };
const kind = (bpm: number, ref: number) => { const r = bpm / ref, near = (x: number) => Math.abs(r / x - 1) < 0.005; return near(1) ? 'exact' : near(2) || near(0.5) ? 'octave' : near(1.5) || near(2 / 3) ? '3:2' : 'other'; };
const report = (name: string, set: Song[]) => {
  const count = (f: (s: Song) => string, k: string) => set.filter((s) => f(s) === k).length;
  const h = (s: Song) => kind(s.heuristic, s.ref), m = (s: Song) => kind(pick(s).bpm, s.ref), hy = (s: Song) => kind(pickHybrid(s).bpm, s.ref);
  const cov = set.filter((s) => s.cands.some((c) => c.y)).length;
  console.log(`${name}: ${set.length} songs (ranked BPM among the candidates: ${cov})`);
  for (const [label, f] of [['heuristic', h], ['model', m], ['hybrid', hy]] as const) {
    console.log(`  ${label.padEnd(9)} exact ${count(f, 'exact')} (${(100 * count(f, 'exact') / set.length).toFixed(0)}%)  octave ${count(f, 'octave')}  3:2 ${count(f, '3:2')}  other ${count(f, 'other')}`);
  }
};
report('train (ranked)', train.filter((s) => s.id >= 0));
report('train (synthetic)', train.filter((s) => s.id < 0));
report('test (held out)', test);
console.log('weights:', TEMPO_FEATURES.map((n, j) => `${n} ${w[j].toFixed(2)}`).join(', '));

if (!argv.includes('--dry')) {
  const h = test.filter((s) => kind(s.heuristic, s.ref) === 'exact').length, m = test.filter((s) => kind(pick(s).bpm, s.ref) === 'exact').length;
  const note = `trained on ${train.filter((s) => s.id >= 0).length} ranked + ${train.filter((s) => s.id < 0).length} synthetic songs; held-out ${test.length}: exact BPM ${h} -> ${m} (heuristic -> model)`;
  writeFileSync('src/automap/tempomodel.ts', `/** Learned tempo choice (logistic regression over tempo candidates); regenerated by scripts/bench/train-tempo-model.ts. */
export interface TempoModel { w: number[]; mean: number[]; std: number[]; note: string }
// features: ${TEMPO_FEATURES.join(', ')}
export const TEMPO_MODEL: TempoModel | null = ${JSON.stringify({ w: w.map((v) => +v.toFixed(5)), mean: mean.map((v) => +v.toFixed(5)), std: std.map((v) => +v.toFixed(5)), note })};
`);
  console.log(`wrote src/automap/tempomodel.ts (${note})`);
}
