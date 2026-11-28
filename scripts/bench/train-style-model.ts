/**
 * Train the auto-style model: per measure, audio features + target stars -> the pattern style the
 * ranked map uses there. Writes src/automap/stylemodel.ts.
 *
 *   npx tsx scripts/bench/train-style-model.ts DATA_DIR [DATA_DIR...] [--cache f.json] [--write]
 *
 * Split by beatmap set id (% 3 == 0 held out), each song once even when it sits in several data
 * folders. --cache keeps the extracted measures (incremental: cached songs are not analysed again).
 * Reports held-out accuracy per key count and star range for the shipped and the new model;
 * --write writes src/automap/stylemodel.ts.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, getKeys, isLN, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze, detectOnsets } from '../../src/automap/analysis';
import { starRating } from '../../src/analysis/difficulty';
import { classifyPatterns, type PatternType } from '../../src/analysis/patterns';
import { STYLE_CLASSES, FEATURE_NAMES, songContext, measureFeatures, predictStyle, type StyleModel } from '../../src/automap/stylefeatures';
import { STYLE_MODEL } from '../../src/automap/stylemodel';

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--cache', '--mlp'].includes(argv[i - 1])));
const H = Number(opt('mlp') ?? 0);
// --cache a.json[,b.json...]: all are read, new songs are written to the first
const caches = (opt('cache') ?? '').split(',').filter(Boolean);
const cacheFile = caches[0];

export function styleOfPattern(p: PatternType): number {
  switch (p) {
    case 'stream': case 'roll': case 'trill': case 'minitrill': return 1;
    case 'jumpstream': case 'handstream': case 'quadstream': case 'doublestream': case 'lightchordstream': case 'densechordstream': return 2;
    case 'jack': case 'longjack': case 'chordjack': return 3;
    case 'brackets': case 'chordroll': case 'jumptrill': case 'splittrill': return 4;
    case 'inverse': case 'lncoordination': case 'lnrelease': case 'lndensity': case 'ln': return 5;
    default: return 0;
  }
}

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

interface Sample { x: number[]; y: number; id: number; keys: number; stars: number; test: boolean }

let samples: Sample[] = [];
const done = new Set<number>();
for (const c of caches) {
  if (!existsSync(c)) continue;
  const seen = new Set(done); // a song extracted by two parallel runs counts once
  for (const s of JSON.parse(readFileSync(c, 'utf8')) as Sample[]) if (!seen.has(s.id)) { samples.push(s); done.add(s.id); }
}
const own = cacheFile && existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, 'utf8')) as Sample[]) : [];
const fresh: Sample[] = [];
let added = 0;
for (const dir of dirs) {
  for (const set of readdirSync(dir).sort()) {
    const id = Number(set.split(' ')[0]);
    if (!Number.isFinite(id) || done.has(id)) continue;
    done.add(id);
    const p = join(dir, set);
    let files: string[];
    try { if (!statSync(p).isDirectory()) continue; files = readdirSync(p); } catch { continue; }
    const audio = files.find((f) => /^audio\./.test(f));
    if (!audio) continue;
    const maps: Beatmap[] = [];
    for (const f of files.filter((x) => x.endsWith('.osu'))) {
      try {
        const m = parseOsu(readFileSync(join(p, f), 'utf8'));
        if (redLines(m).length === 1 && getKeys(m) >= 4 && getKeys(m) <= 10 && m.notes.length > 100 && m.notes.filter(isLN).length / m.notes.length <= 0.2) maps.push(m);
      } catch { /* skip */ }
    }
    if (!maps.length) continue;
    let a;
    try { a = analyze(decode(join(p, audio)), 22050); } catch { continue; }
    const ctx = songContext(a, detectOnsets(a, 0.5));
    for (const m of maps) {
      const red = redLines(m)[0];
      const beat = red.beatLength, bpm = 60000 / beat;
      const stars = starRating(m).stars;
      const pr = classifyPatterns(m);
      // per measure: majority style of its rows
      const byMeasure = new Map<number, number[]>();
      pr.rows.forEach((r, i) => {
        const k = Math.floor((r.time - red.time) / (beat * 4) + 1e-6);
        const arr = byMeasure.get(k) ?? new Array(STYLE_CLASSES.length).fill(0);
        arr[styleOfPattern(pr.labels[i])]++;
        byMeasure.set(k, arr);
      });
      for (const [k, counts] of byMeasure) {
        const total = counts.reduce((x, y) => x + y, 0);
        if (total < 4) continue;
        const y = counts.indexOf(Math.max(...counts));
        const t0 = red.time + k * beat * 4;
        fresh.push({ x: measureFeatures(ctx, t0, t0 + beat * 4, 4, bpm, stars, getKeys(m)).map((v) => +v.toFixed(5)), y, id, keys: getKeys(m), stars: +stars.toFixed(2), test: id % 3 === 0 });
      }
    }
    if (++added % 50 === 0) console.log(`${done.size} songs, ${samples.length + fresh.length} measures`);
  }
}
samples.push(...fresh);
if (cacheFile && added) writeFileSync(cacheFile, JSON.stringify([...own, ...fresh]));

// rice styles only: balanced (slow), stream, jumpstream, chordjack; tech is too rare in ranked maps
const CLASSES = ['balanced', 'stream', 'jumpstream', 'chordjack'] as const;
samples = samples.filter((s) => s.y <= 3);
const train = samples.filter((s) => !s.test), test = samples.filter((s) => s.test);
const F = FEATURE_NAMES.length, C = CLASSES.length;
const mean = new Array(F).fill(0), std = new Array(F).fill(0);
for (const s of train) s.x.forEach((v, i) => { mean[i] += v / train.length; });
for (const s of train) s.x.forEach((v, i) => { std[i] += (v - mean[i]) ** 2 / train.length; });
for (let i = 0; i < F; i++) std[i] = Math.sqrt(std[i]);
mean[F - 1] = 0; std[F - 1] = 0; // bias stays 1

// class weights against imbalance
const counts = new Array(C).fill(0);
for (const s of train) counts[s.y]++;
const cw = counts.map((c) => (c ? Math.sqrt(train.length / (C * c)) : 0));

const W = Array.from({ length: C }, () => new Array(F).fill(0));
const z = (x: number[]) => x.map((v, i) => (std[i] > 0 ? (v - mean[i]) / std[i] : v));
const Z = train.map((s) => z(s.x));
const lr = 0.3, l2 = 1e-3;
for (let epoch = 0; epoch < 400; epoch++) {
  const G = Array.from({ length: C }, () => new Array(F).fill(0));
  Z.forEach((x, n) => {
    const logits = W.map((w) => w.reduce((s, wi, i) => s + wi * x[i], 0));
    const m = Math.max(...logits);
    const e = logits.map((l) => Math.exp(l - m));
    const sum = e.reduce((a, b) => a + b, 0);
    for (let c = 0; c < C; c++) {
      const g = (e[c] / sum - (train[n].y === c ? 1 : 0)) * cw[train[n].y];
      for (let i = 0; i < F; i++) G[c][i] += g * x[i];
    }
  });
  for (let c = 0; c < C; c++) for (let i = 0; i < F; i++) W[c][i] -= lr * (G[c][i] / Z.length + l2 * W[c][i]);
}
const model: StyleModel = { classes: [...CLASSES], weights: W.map((w) => w.map((v) => +v.toFixed(4))), mean: mean.map((v) => +v.toFixed(4)), std: std.map((v) => +v.toFixed(4)) };

// optional hidden layer on top of the linear logits (Adam, class-weighted, minibatches)
if (H > 0) {
  const P = H * F + H + C * H + C;
  const th = new Float64Array(P), m1 = new Float64Array(P), m2 = new Float64Array(P);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  for (let j = 0; j < H * F; j++) th[j] = (Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd())) * Math.sqrt(2 / F);
  const lin = Z.map((x) => model.weights.map((w) => w.reduce((s, wi, i) => s + wi * x[i], 0)));
  const order = Z.map((_, i) => i);
  const act = new Float64Array(H), g = new Float64Array(P);
  let step = 0;
  for (let e = 0; e < 8; e++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let loss = 0;
    for (let b0 = 0; b0 < order.length; b0 += 256) {
      g.fill(0);
      const b1 = Math.min(order.length, b0 + 256);
      for (let q = b0; q < b1; q++) {
        const n = order[q], x = Z[n], y = train[n].y, w = cw[y];
        for (let j = 0; j < H; j++) { let a = th[H * F + j]; for (let i = 0; i < F; i++) a += th[j * F + i] * x[i]; act[j] = a > 0 ? a : 0; }
        const lg = lin[n].map((v, c) => { let t = v + th[H * F + H + C * H + c]; for (let j = 0; j < H; j++) t += th[H * F + H + c * H + j] * act[j]; return t; });
        const mx = Math.max(...lg), ex = lg.map((l) => Math.exp(l - mx)), sm = ex.reduce((a, b) => a + b, 0);
        loss -= w * Math.log(ex[y] / sm + 1e-12);
        for (let c = 0; c < C; c++) {
          const d = (ex[c] / sm - (c === y ? 1 : 0)) * w;
          g[H * F + H + C * H + c] += d;
          for (let j = 0; j < H; j++) {
            if (!act[j]) continue;
            g[H * F + H + c * H + j] += d * act[j];
            const dj = d * th[H * F + H + c * H + j];
            g[H * F + j] += dj;
            for (let i = 0; i < F; i++) g[j * F + i] += dj * x[i];
          }
        }
      }
      step++;
      for (let k = 0; k < P; k++) {
        const gk = g[k] / (b1 - b0) + 1e-5 * th[k];
        m1[k] = 0.9 * m1[k] + 0.1 * gk; m2[k] = 0.999 * m2[k] + 0.001 * gk * gk;
        th[k] -= 1e-3 * (m1[k] / (1 - 0.9 ** step)) / (Math.sqrt(m2[k] / (1 - 0.999 ** step)) + 1e-8);
      }
    }
    console.log(`  hidden layer epoch ${e + 1}: weighted log-loss ${(loss / order.length).toFixed(4)}`);
  }
  const r = (v: ArrayLike<number>) => Array.from(v, (x) => +x.toFixed(4));
  model.mlp = { h: H, W1: r(th.subarray(0, H * F)), b1: r(th.subarray(H * F, H * F + H)),
    W2: Array.from({ length: C }, (_, c) => r(th.subarray(H * F + H + c * H, H * F + H + (c + 1) * H))), b2: r(th.subarray(H * F + H + C * H, P)) };
}

const evalSet = (set: Sample[]) => {
  let ok = 0;
  const conf = Array.from({ length: C }, () => new Array(C).fill(0));
  for (const s of set) {
    const p = predictStyle(model, s.x);
    const k = p.indexOf(Math.max(...p));
    conf[s.y][k]++;
    if (k === s.y) ok++;
  }
  return { acc: ok / Math.max(1, set.length), conf };
};
const accOf = (set: Sample[], m: StyleModel) => set.length ? set.filter((s) => { const p = predictStyle(m, s.x); return p.indexOf(Math.max(...p)) === s.y; }).length / set.length : NaN;
console.log('\nheld-out accuracy per group (shipped model -> new)');
for (const k of [4, 6, 7]) for (const [lo, hi] of [[0, 4], [4, 6], [6, 8], [8, 99]]) {
  const g = test.filter((s) => s.keys === k && s.stars >= lo && s.stars < hi);
  if (g.length < 50) continue;
  console.log(`  ${k}K ${lo}-${hi === 99 ? '' : hi}★ ${String(g.length).padStart(6)} measures   ${accOf(g, STYLE_MODEL).toFixed(3)} -> ${accOf(g, model).toFixed(3)}`);
}
console.log(`  all        ${String(test.length).padStart(6)} measures   ${accOf(test, STYLE_MODEL).toFixed(3)} -> ${accOf(test, model).toFixed(3)}`);
const base = Math.max(...counts) / train.length;
const tr = evalSet(train), te = evalSet(test);
console.log(`\ntrain ${train.length} samples, test ${test.length} (held-out songs)`);
console.log(`class counts ${CLASSES.map((c, i) => `${c}:${counts[i]}`).join(' ')}`);
console.log(`accuracy train ${tr.acc.toFixed(3)}  test ${te.acc.toFixed(3)}  (majority-class baseline ${base.toFixed(3)})`);
console.log('test confusion (rows = ranked map, cols = predicted):');
console.log('            ' + CLASSES.map((c) => c.slice(0, 7).padStart(8)).join(''));
te.conf.forEach((r, i) => console.log(CLASSES[i].padEnd(12) + r.map((v) => String(v).padStart(8)).join('')));

if (argv.includes('--write')) writeFileSync(new URL('../../src/automap/stylemodel.ts', import.meta.url), `/**
 * Learned auto-style model (multinomial logistic regression), trained by
 * scripts/bench/train-style-model.ts on ${train.length} measures of ranked osu!mania maps.
 * Held-out accuracy ${te.acc.toFixed(3)} (majority baseline ${base.toFixed(3)}).
 */
import type { StyleModel } from './stylefeatures';

export const STYLE_MODEL: StyleModel = ${JSON.stringify(model)};
`);
if (argv.includes('--write')) console.log('wrote src/automap/stylemodel.ts');
