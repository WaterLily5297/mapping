/**
 * Train the rhythm model: for each grid tick, does the ranked map have a note there? Logistic
 * regression over tickFeatures(). One shared model, plus one per key count (4K, 6K, 7K) that starts
 * from the shared weights and is pulled towards them (so a key count with fewer maps stays close
 * to the shared model).
 *
 *   npx tsx scripts/bench/train-rhythm-model.ts DATA_DIR [DATA_DIR...] [--cache DIR] [--mlp 32] [--write]
 *
 * --mlp H adds H hidden ReLU units on top of the linear model (a residual on its log-odds, trained
 * with Adam on minibatches), shared and then fine-tuned per key count.
 *
 * Split by beatmap set id (% 3 == 0 held out), each song once even when it sits in several data
 * folders. Up to 3 maps per song and key count. Reports held-out precision at the ranked note
 * count (pick as many ticks as the map has rows) per key count and star range, for the shipped
 * model, the new shared model and the per-key models. --write writes src/automap/rhythmmodel.ts.
 * --cache DIR keeps the extracted ticks (incremental: songs already there are not analysed again).
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, getKeys, isLN, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze, detectOnsets } from '../../src/automap/analysis';
import { starRating } from '../../src/analysis/difficulty';
import { RHYTHM_FEATURES, gridTicksFor, gridDivisors, rhythmContext, tickFeatures, rhythmScore, type RhythmModel } from '../../src/automap/rhythm';
import { RHYTHM_MODEL } from '../../src/automap/rhythmmodel';

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--cache', '--mlp'].includes(argv[i - 1])));
// --cache DIR[,DIR...]: all are read, new songs are written to the first (parallel extraction runs
// each write their own and a training run reads them all)
const cacheDirs = (opt('cache') ?? '').split(',').filter(Boolean);
const cacheDir = cacheDirs[0];
const F = RHYTHM_FEATURES.length;
const PER_KEY = [4, 6, 7];
const H = Number(opt('mlp') ?? 0);

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

/** one map's ticks: features (F per tick), labels, and the map's key count, stars and song id */
interface Chunk { id: number; keys: number; stars: number; x: Float32Array; y: Uint8Array }
const chunks: Chunk[] = [];
const done = new Set<number>();
// cache: index.jsonl (one line per map: id, keys, stars, ticks, byte offset) + x.f32 + y.u8
if (cacheDir) mkdirSync(cacheDir, { recursive: true });
for (const dir of cacheDirs) {
  const idx = join(dir, 'index.jsonl');
  const before = new Set(done); // a song extracted by two parallel runs counts once
  if (existsSync(idx)) {
    const xb = readFileSync(join(dir, 'x.f32')), yb = readFileSync(join(dir, 'y.u8'));
    for (const line of readFileSync(idx, 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line) as { id: number; keys: number; stars: number; n: number; off: number };
      if (before.has(e.id)) continue;
      done.add(e.id);
      if (e.n === 0) continue;
      chunks.push({ id: e.id, keys: e.keys, stars: e.stars,
        x: new Float32Array(xb.buffer.slice(xb.byteOffset + e.off * F * 4, xb.byteOffset + (e.off + e.n) * F * 4)),
        y: new Uint8Array(yb.buffer.slice(yb.byteOffset + e.off, yb.byteOffset + e.off + e.n)) });
    }
  }
}
let offset = cacheDir && existsSync(join(cacheDir, 'y.u8')) ? statSync(join(cacheDir, 'y.u8')).size : 0;
const before = done.size;
for (const dir of dirs) for (const set of readdirSync(dir).sort()) {
  const id = Number(set.split(' ')[0]);
  if (!Number.isFinite(id) || done.has(id)) continue;
  const p = join(dir, set);
  let files: string[];
  try { if (!statSync(p).isDirectory()) continue; files = readdirSync(p); } catch { continue; }
  const audio = files.find((f) => /^audio\./.test(f));
  if (!audio) continue;
  const byKeys = new Map<number, { m: Beatmap; s: number }[]>();
  for (const f of files.filter((x) => x.endsWith('.osu'))) {
    try {
      const m = parseOsu(readFileSync(join(p, f), 'utf8'));
      const k = getKeys(m);
      if (redLines(m).length === 1 && k >= 4 && k <= 10 && m.notes.length > 100 && m.notes.filter(isLN).length / m.notes.length < 0.2) {
        (byKeys.get(k) ?? byKeys.set(k, []).get(k)!).push({ m, s: starRating(m).stars });
      }
    } catch { /* skip */ }
  }
  done.add(id);
  const maps = [...byKeys.values()].flatMap((l) => {
    // up to 3 per key count, spread over the star range (hardest, easiest, middle)
    l.sort((a, b) => b.s - a.s);
    return l.length <= 3 ? l : [l[0], l[l.length - 1], l[Math.floor(l.length / 2)]];
  });
  const lines: string[] = [];
  if (maps.length) {
    let a;
    try { a = analyze(decode(join(p, audio)), 22050); } catch { continue; }
    const ctx = rhythmContext(a, detectOnsets(a, 0.5));
    for (const { m, s: stars } of maps) {
      const beat = redLines(m)[0].beatLength;
      const divs = gridDivisors(beat, stars);
      const finest = Math.max(...divs);
      const rows = [...new Set(m.notes.map((n) => n.time))].sort((x, y) => x - y);
      const ticks = gridTicksFor(m, divs, rows[0] - beat * 2, rows[rows.length - 1] + 1);
      // ticks are at least 1/24 beat apart (1/8 next to 1/6): keep the label window inside that
      const tol = Math.max(8, Math.min(20, beat / 24 / 2));
      const cur = { i: 0 };
      const x = new Float32Array(ticks.length * F), y = new Uint8Array(ticks.length);
      let ri = 0;
      ticks.forEach((tk, n) => {
        x.set(tickFeatures(ctx, m, tk, stars, cur, finest), n * F);
        while (ri < rows.length && rows[ri] < tk.t - tol) ri++;
        y[n] = ri < rows.length && Math.abs(rows[ri] - tk.t) <= tol ? 1 : 0;
      });
      const keys = getKeys(m);
      chunks.push({ id, keys, stars, x, y });
      if (cacheDir) {
        appendFileSync(join(cacheDir, 'x.f32'), Buffer.from(x.buffer));
        appendFileSync(join(cacheDir, 'y.u8'), Buffer.from(y.buffer));
        lines.push(JSON.stringify({ id, keys, stars: +stars.toFixed(3), n: y.length, off: offset }));
      }
      offset += y.length;
    }
  }
  if (cacheDir) appendFileSync(join(cacheDir, 'index.jsonl'), (lines.length ? lines : [JSON.stringify({ id, keys: 0, stars: 0, n: 0, off: offset })]).join('\n') + '\n');
  if ((done.size - before) % 25 === 0) console.log(`${done.size} songs, ${chunks.length} maps, ${offset} ticks`);
}

const isTest = (c: Chunk) => c.id % 3 === 0;
const train = chunks.filter((c) => !isTest(c)), test = chunks.filter(isTest);
const nOf = (cs: Chunk[]) => cs.reduce((s, c) => s + c.y.length, 0);
console.log(`\n${new Set(chunks.map((c) => c.id)).size} songs, ${chunks.length} maps: ${nOf(train)} train ticks, ${nOf(test)} held-out ticks`);

// standardise on the training ticks (the bias feature stays as it is)
const mean = new Float64Array(F), std = new Float64Array(F);
const nTrain = nOf(train);
for (const c of train) for (let n = 0; n < c.y.length; n++) for (let i = 0; i < F; i++) mean[i] += c.x[n * F + i];
for (let i = 0; i < F; i++) mean[i] /= nTrain;
for (const c of train) for (let n = 0; n < c.y.length; n++) for (let i = 0; i < F; i++) std[i] += (c.x[n * F + i] - mean[i]) ** 2;
for (let i = 0; i < F; i++) std[i] = Math.sqrt(std[i] / nTrain);
mean[F - 1] = 0; std[F - 1] = 0;
const zOf = (v: number, i: number) => (std[i] > 0 ? (v - mean[i]) / std[i] : v);

/** full-batch gradient descent; `prior` pulls the weights towards a reference model */
function fit(cs: Chunk[], init: Float64Array, epochs: number, prior?: { w: Float64Array; lambda: number }): Float64Array {
  const w = Float64Array.from(init), n = nOf(cs), z = new Float64Array(F);
  for (let e = 0; e < epochs; e++) {
    const g = new Float64Array(F);
    for (const c of cs) for (let k = 0; k < c.y.length; k++) {
      let s = 0;
      for (let i = 0; i < F; i++) { z[i] = zOf(c.x[k * F + i], i); s += w[i] * z[i]; }
      const d = 1 / (1 + Math.exp(-s)) - c.y[k];
      for (let i = 0; i < F; i++) g[i] += d * z[i];
    }
    for (let i = 0; i < F; i++) w[i] -= 0.5 * (g[i] / n + 1e-4 * w[i] + (prior ? prior.lambda * (w[i] - prior.w[i]) : 0));
  }
  return w;
}
const asModel = (w: Float64Array): RhythmModel => ({ w: [...w].map((v) => +v.toFixed(4)), mean: [...mean].map((v) => +v.toFixed(4)), std: [...std].map((v) => +v.toFixed(4)) });

console.log('training the shared model...');
const shared = asModel(fit(train, new Float64Array(F), 300));
const perKey: Record<number, RhythmModel> = {};
for (const k of PER_KEY) {
  const cs = train.filter((c) => c.keys === k);
  if (nOf(cs) < 50000) continue;
  console.log(`training ${k}K (${cs.length} maps)...`);
  perKey[k] = asModel(fit(cs, Float64Array.from(shared.w), 200, { w: Float64Array.from(shared.w), lambda: 0.01 }));
}

/** residual hidden layer on top of a linear model, Adam on shuffled minibatches */
function fitMlp(cs: Chunk[], base: RhythmModel, epochs: number, lr: number, init?: RhythmModel['mlp']): NonNullable<RhythmModel['mlp']> {
  const N = nOf(cs), Z = new Float32Array(N * F), Y = new Uint8Array(N), L = new Float32Array(N);
  let o = 0;
  for (const c of cs) for (let k = 0; k < c.y.length; k++, o++) {
    let lin = 0;
    for (let i = 0; i < F; i++) { const v = zOf(c.x[k * F + i], i); Z[o * F + i] = v; lin += base.w[i] * v; }
    Y[o] = c.y[k]; L[o] = lin;
  }
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const P = H * F + H + H + 1; // W1, b1, w2, b2
  const th = new Float64Array(P);
  if (init) { th.set(init.W1, 0); th.set(init.b1, H * F); th.set(init.w2, H * F + H); th[P - 1] = init.b2; }
  else for (let j = 0; j < H * F; j++) th[j] = gauss() * Math.sqrt(2 / F);
  const m1 = new Float64Array(P), m2 = new Float64Array(P), g = new Float64Array(P), act = new Float64Array(H);
  const order = new Uint32Array(N).map((_, i) => i);
  const B = 1024;
  let step = 0;
  for (let e = 0; e < epochs; e++) {
    for (let i = N - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
    let loss = 0;
    for (let b0 = 0; b0 < N; b0 += B) {
      g.fill(0);
      const b1 = Math.min(N, b0 + B);
      for (let q = b0; q < b1; q++) {
        const n = order[q];
        let z = L[n] + th[P - 1];
        for (let j = 0; j < H; j++) {
          let a = th[H * F + j];
          for (let i = 0; i < F; i++) a += th[j * F + i] * Z[n * F + i];
          act[j] = a > 0 ? a : 0;
          z += th[H * F + H + j] * act[j];
        }
        const p = 1 / (1 + Math.exp(-z)), d = p - Y[n];
        loss -= Y[n] ? Math.log(p + 1e-9) : Math.log(1 - p + 1e-9);
        g[P - 1] += d;
        for (let j = 0; j < H; j++) {
          g[H * F + H + j] += d * act[j];
          if (act[j] > 0) { const dj = d * th[H * F + H + j]; g[H * F + j] += dj; for (let i = 0; i < F; i++) g[j * F + i] += dj * Z[n * F + i]; }
        }
      }
      step++;
      const bs = b1 - b0;
      for (let k = 0; k < P; k++) {
        const gk = g[k] / bs + 1e-5 * th[k];
        m1[k] = 0.9 * m1[k] + 0.1 * gk; m2[k] = 0.999 * m2[k] + 0.001 * gk * gk;
        th[k] -= lr * (m1[k] / (1 - 0.9 ** step)) / (Math.sqrt(m2[k] / (1 - 0.999 ** step)) + 1e-8);
      }
    }
    console.log(`  epoch ${e + 1}: train log-loss ${(loss / N).toFixed(4)}`);
  }
  const r = (v: ArrayLike<number>) => Array.from(v, (x) => +x.toFixed(4));
  return { h: H, W1: r(th.subarray(0, H * F)), b1: r(th.subarray(H * F, H * F + H)), w2: r(th.subarray(H * F + H, H * F + 2 * H)), b2: +th[P - 1].toFixed(4) };
}
let mlpShared: RhythmModel | undefined;
const mlpPerKey: Record<number, RhythmModel> = {};
if (H > 0) {
  console.log(`training the hidden layer (${H} units)...`);
  mlpShared = { ...shared, mlp: fitMlp(train, shared, 4, 2e-3) };
  for (const k of PER_KEY) {
    const cs = train.filter((c) => c.keys === k);
    if (nOf(cs) < 50000) continue;
    console.log(`fine-tuning for ${k}K...`);
    mlpPerKey[k] = { ...shared, mlp: fitMlp(cs, shared, 1, 5e-4, mlpShared.mlp) };
  }
}

/** held-out precision at the ranked note count, averaged over maps (each map ranks its own ticks) */
function precision(cs: Chunk[], model: (c: Chunk) => RhythmModel): number {
  if (!cs.length) return NaN;
  let sum = 0;
  for (const c of cs) {
    const m = model(c), n = c.y.length;
    const scored: [number, number][] = [];
    for (let k = 0; k < n; k++) scored.push([rhythmScore(m, c.x.subarray(k * F, k * F + F)), c.y[k]]);
    scored.sort((a, b) => b[0] - a[0]);
    const pos = c.y.reduce((s, v) => s + v, 0);
    let hit = 0;
    for (let k = 0; k < pos; k++) hit += scored[k][1];
    sum += hit / Math.max(1, pos);
  }
  return sum / cs.length;
}
const groups: [string, (c: Chunk) => boolean][] = [];
for (const k of PER_KEY) for (const [lo, hi] of [[0, 4], [4, 6], [6, 8], [8, 99]]) groups.push([`${k}K ${lo}-${hi === 99 ? '' : hi}★`, (c) => c.keys === k && c.stars >= lo && c.stars < hi]);
groups.push(['other keys', (c) => !PER_KEY.includes(c.keys)]);
console.log('\nheld-out precision at the ranked note count (per map, mean)');
console.log(`${'group'.padEnd(14)} maps   shipped   new shared   per key${H ? '   MLP     MLP per key' : ''}`);
for (const [name, f] of groups) {
  const cs = test.filter(f);
  if (!cs.length) continue;
  const k = cs[0].keys;
  const mlpCols = H ? `   ${precision(cs, () => mlpShared!).toFixed(3)}   ${mlpPerKey[k] ? precision(cs, () => mlpPerKey[k]).toFixed(3) : '  -  '}` : '';
  console.log(`${name.padEnd(14)} ${String(cs.length).padStart(4)}   ${precision(cs, () => RHYTHM_MODEL).toFixed(3)}     ${precision(cs, () => shared).toFixed(3)}        ${perKey[k] ? precision(cs, () => perKey[k]).toFixed(3) : '  -  '}${mlpCols}`);
}

{
  const all = (f: (c: Chunk) => RhythmModel) => precision(test.filter((c) => PER_KEY.includes(c.keys)), f);
  console.log(`${'all 4/6/7K'.padEnd(14)} ${String(test.filter((c) => PER_KEY.includes(c.keys)).length).padStart(4)}   ${all(() => RHYTHM_MODEL).toFixed(3)}     ${all(() => shared).toFixed(3)}        ${all((c) => perKey[c.keys] ?? shared).toFixed(3)}${H ? `   ${all(() => mlpShared!).toFixed(3)}   ${all((c) => mlpPerKey[c.keys] ?? mlpShared!).toFixed(3)}` : ''}`);
}

if (argv.includes('--write')) {
  // with --mlp: the shared model with its hidden layer (fine-tuning per key count added nothing on
  // held-out maps); without: the linear shared and per-key models
  const best = mlpShared ?? shared, byKeys = mlpShared ? {} : perKey;
  const overall = (m: (c: Chunk) => RhythmModel) => precision(test.filter((c) => PER_KEY.includes(c.keys)), m).toFixed(3);
  writeFileSync(new URL('../../src/automap/rhythmmodel.ts', import.meta.url), `/**
 * Learned rhythm model, trained by scripts/bench/train-rhythm-model.ts${H ? ` --mlp ${H}` : ''} on ${nTrain} ticks
 * of ranked osu!mania maps (${train.length} maps from ${new Set(train.map((c) => c.id)).size} songs, beatmap set id % 3 != 0):
 * logistic regression over tickFeatures()${H ? ` with ${H} hidden units on its log-odds` : ''}. Held-out precision
 * at the ranked note count on ${test.filter((c) => PER_KEY.includes(c.keys)).length} 4K/6K/7K maps: ${overall(() => best)} (the model before
 * this one: ${overall(() => RHYTHM_MODEL)}).
 */
import type { RhythmModel } from './rhythm';

export const RHYTHM_MODEL: RhythmModel = ${JSON.stringify(best)};

export const RHYTHM_MODELS_BY_KEYS: Record<number, RhythmModel> = ${JSON.stringify(byKeys)};
`);
  console.log('wrote src/automap/rhythmmodel.ts');
}
