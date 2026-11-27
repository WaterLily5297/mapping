/**
 * Train the rhythm model: for each grid tick, does the ranked map have a note there?
 * Writes src/automap/rhythmmodel.ts.
 *
 *   npx tsx scripts/bench/train-rhythm-model.ts DATA_DIR [DATA_DIR...] [--holdout 3] [--cache f.bin]
 *
 * Songs whose index (sorted, per data dir) is divisible by --holdout are kept out for testing,
 * the same split as the style model and generator-bench --holdout.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, getKeys, isLN, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze, detectOnsets } from '../../src/automap/analysis';
import { starRating } from '../../src/analysis/difficulty';
import { RHYTHM_FEATURES, gridTicksFor, gridDivisors, rhythmContext, tickFeatures, rhythmScore, type RhythmModel } from '../../src/automap/rhythm';

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const holdout = Number(opt('holdout') ?? 3);
const cache = opt('cache');
const F = RHYTHM_FEATURES.length;

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

let X: number[] = [];
let Y: number[] = [];
let T: number[] = []; // 1 = test
if (cache && existsSync(cache)) ({ X, Y, T } = JSON.parse(readFileSync(cache, 'utf8')));
else {
  for (const dir of dirs) {
    readdirSync(dir).sort().forEach((set, idx) => {
      const p = join(dir, set);
      let files: string[];
      try { files = readdirSync(p); } catch { return; }
      const audio = files.find((f) => /^audio\./.test(f));
      if (!audio) return;
      const maps: Beatmap[] = [];
      for (const f of files.filter((x) => x.endsWith('.osu'))) {
        try {
          const m = parseOsu(readFileSync(join(p, f), 'utf8'));
          if (redLines(m).length === 1 && getKeys(m) >= 4 && getKeys(m) <= 10 && m.notes.length > 100
            && m.notes.filter(isLN).length / m.notes.length < 0.2) maps.push(m);
        } catch { /* skip */ }
      }
      if (!maps.length) return;
      const a = analyze(decode(join(p, audio)), 22050);
      const ctx = rhythmContext(a, detectOnsets(a, 0.5));
      for (const m of maps) {
        const beat = redLines(m)[0].beatLength;
        const stars = starRating(m).stars;
        const divs = gridDivisors(beat, stars);
        const finest = Math.max(...divs);
        const rows = [...new Set(m.notes.map((n) => n.time))].sort((x, y) => x - y);
        const ticks = gridTicksFor(m, divs, rows[0] - beat * 2, rows[rows.length - 1] + 1);
        // ticks are at least 1/24 beat apart (1/8 next to 1/6): keep the label window inside that
        const tol = Math.max(8, Math.min(20, beat / 24 / 2));
        const cur = { i: 0 };
        let ri = 0;
        for (const tk of ticks) {
          const x = tickFeatures(ctx, m, tk, stars, cur, finest);
          while (ri < rows.length && rows[ri] < tk.t - tol) ri++;
          X.push(...x);
          Y.push(ri < rows.length && Math.abs(rows[ri] - tk.t) <= tol ? 1 : 0);
          T.push(idx % holdout === 0 ? 1 : 0);
        }
      }
      console.log(`${Y.length} ticks  ${set.slice(0, 50)}`);
    });
  }
  if (cache) writeFileSync(cache, JSON.stringify({ X, Y, T }));
}

const N = Y.length;
const mean = new Array(F).fill(0), std = new Array(F).fill(0);
let nTrain = 0;
for (let n = 0; n < N; n++) if (!T[n]) { nTrain++; for (let i = 0; i < F; i++) mean[i] += X[n * F + i]; }
for (let i = 0; i < F; i++) mean[i] /= nTrain;
for (let n = 0; n < N; n++) if (!T[n]) for (let i = 0; i < F; i++) std[i] += (X[n * F + i] - mean[i]) ** 2;
for (let i = 0; i < F; i++) std[i] = Math.sqrt(std[i] / nTrain);
mean[F - 1] = 0; std[F - 1] = 0;
const Z = new Float32Array(N * F);
for (let n = 0; n < N; n++) for (let i = 0; i < F; i++) Z[n * F + i] = std[i] > 0 ? (X[n * F + i] - mean[i]) / std[i] : X[n * F + i];

const w = new Float64Array(F);
for (let epoch = 0; epoch < 300; epoch++) {
  const g = new Float64Array(F);
  for (let n = 0; n < N; n++) {
    if (T[n]) continue;
    let z = 0;
    for (let i = 0; i < F; i++) z += w[i] * Z[n * F + i];
    const d = 1 / (1 + Math.exp(-z)) - Y[n];
    for (let i = 0; i < F; i++) g[i] += d * Z[n * F + i];
  }
  for (let i = 0; i < F; i++) w[i] -= 0.5 * (g[i] / nTrain + 1e-4 * w[i]);
}
const model: RhythmModel = { w: [...w].map((v) => +v.toFixed(4)), mean: mean.map((v) => +v.toFixed(4)), std: std.map((v) => +v.toFixed(4)) };

// held-out: precision at the true number of notes (pick as many ticks as the map has notes)
function evalTop(test: boolean, score: (n: number) => number) {
  const idx: number[] = [];
  for (let n = 0; n < N; n++) if (!!T[n] === test) idx.push(n);
  const pos = idx.filter((n) => Y[n]).length;
  const sorted = idx.map((n) => [score(n), Y[n]] as const).sort((a, b) => b[0] - a[0]);
  let hit = 0;
  for (let k = 0; k < pos; k++) hit += sorted[k][1];
  return hit / Math.max(1, pos);
}
const learned = (n: number) => rhythmScore(model, Array.from(X.slice(n * F, n * F + F)));
// the old rule: onset strength x metric weight
const rule = (n: number) => {
  const x = X.slice(n * F, n * F + F);
  const metric = x[8] ? 1 : x[9] ? 0.8 : x[10] ? 0.6 : x[11] ? 0.4 : 0.3; // downbeat, beat, half, quarter
  return x[6] * (0.5 + metric) + 1e-3 * metric;
};
console.log(`\n${N} ticks (${nTrain} train), positives ${(Y.reduce((s, y) => s + y, 0) / N * 100).toFixed(1)}%`);
console.log(`held-out precision at the ranked note count: learned ${evalTop(true, learned).toFixed(3)}, old rule ${evalTop(true, rule).toFixed(3)}`);
console.log('weights', RHYTHM_FEATURES.map((f, i) => `${f}:${model.w[i]}`).join(' '));

writeFileSync(new URL('../../src/automap/rhythmmodel.ts', import.meta.url), `/**
 * Learned rhythm model (logistic regression over grid ticks), trained by
 * scripts/bench/train-rhythm-model.ts on ${nTrain} ticks of ranked osu!mania maps.
 */
import type { RhythmModel } from './rhythm';

export const RHYTHM_MODEL: RhythmModel = ${JSON.stringify(model)};
`);
console.log('wrote src/automap/rhythmmodel.ts');
