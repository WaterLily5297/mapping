/**
 * Train the music-energy curve: per measure, the audio features of energy.ts against how dense the
 * ranked map is there (notes per measure, z-scored within the map: its shape, not its difficulty).
 * Ridge regression, split by beatmap set id (% 3 == 0 held out). Reports, on held-out maps, the
 * correlation of the predicted curve with the ranked map's, against loudness alone, by key count
 * and star range. Writes src/automap/energymodel.ts.
 *
 *   npx tsx scripts/bench/train-energy-model.ts DATA_DIR [DATA_DIR...] [--keys 4,6,7] [--cache f.json] [--dry]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, getKeys, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze, detectOnsets } from '../../src/automap/analysis';
import { energyFeatures, ENERGY_FEATURES } from '../../src/automap/energy';
import { starRating } from '../../src/analysis/difficulty';

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--cache', '--keys'].includes(argv[i - 1])));
const cache = opt('cache');
const keysOk = (opt('keys') ?? '4,6,7').split(',').map(Number);
const F = ENERGY_FEATURES.length;

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}
const zs = (v: number[]) => { const m = v.reduce((x, y) => x + y, 0) / v.length; const sd = Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / v.length) || 1; return v.map((x) => (x - m) / sd); };
const pearson = (x: number[], y: number[]) => { const a = zs(x), b = zs(y); return a.reduce((s, v, i) => s + v * b[i], 0) / a.length; };

interface MapRow { id: number; keys: number; stars: number; x: number[][]; y: number[] }
let rows: MapRow[] = [];
if (cache && existsSync(cache)) rows = JSON.parse(readFileSync(cache, 'utf8'));
else {
  const seen = new Set<number>();
  for (const dir of dirs) for (const set of readdirSync(dir).sort()) {
    const p = join(dir, set);
    if (!statSync(p).isDirectory()) continue;
    const id = Number(set.split(' ')[0]);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    const files = readdirSync(p), audio = files.find((f) => /^audio\./.test(f));
    if (!audio) continue;
    const maps = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(p, f), 'utf8')); } catch { return null; } })
      .filter((m): m is Beatmap => !!m && keysOk.includes(getKeys(m)) && m.notes.length > 150 && redLines(m).length === 1);
    if (!maps.length) continue;
    seen.add(id);
    try {
      const a = analyze(decode(join(p, audio)), 22050);
      const on = detectOnsets(a, 0.5);
      for (const m of maps.sort((x, y) => y.notes.length - x.notes.length).slice(0, 3)) {
        const red = redLines(m)[0], bar = red.beatLength * 4;
        const t0 = Math.min(...m.notes.map((n) => n.time)), t1 = Math.max(...m.notes.map((n) => n.time));
        const { starts, x } = energyFeatures(a, on, bar, red.time, t0, t1);
        if (starts.length < 12) continue;
        const counts = starts.map((s) => m.notes.filter((n) => n.time >= s && n.time < s + bar).length);
        rows.push({ id, keys: getKeys(m), stars: starRating(m).stars, x, y: zs(counts) });
      }
      if (seen.size % 25 === 0) console.log(`${seen.size} songs, ${rows.length} maps`);
    } catch (e) { console.log(`skipped ${set}: ${(e as Error).message}`); }
  }
  if (cache) writeFileSync(cache, JSON.stringify(rows));
}

const train = rows.filter((r) => r.id % 3 !== 0), test = rows.filter((r) => r.id % 3 === 0);
// ridge regression by the normal equations (features are already z-scored within each song)
const XtX = Array.from({ length: F }, () => new Float64Array(F)), Xty = new Float64Array(F);
for (const r of train) r.x.forEach((x, i) => { for (let a = 0; a < F; a++) { Xty[a] += x[a] * r.y[i]; for (let b = 0; b < F; b++) XtX[a][b] += x[a] * x[b]; } });
const lambda = 50;
for (let a = 0; a < F; a++) XtX[a][a] += lambda;
// Gaussian elimination
const M = XtX.map((row, i) => [...row, Xty[i]]);
for (let c = 0; c < F; c++) {
  let piv = c; for (let r = c + 1; r < F; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
  [M[c], M[piv]] = [M[piv], M[c]];
  for (let r = 0; r < F; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let j = c; j <= F; j++) M[r][j] -= k * M[c][j]; }
}
const w = M.map((row, i) => row[F] / row[i]);

const score = (set: MapRow[], pred: (x: number[]) => number) => set.length ? set.reduce((s, r) => s + pearson(r.x.map(pred), r.y), 0) / set.length : NaN;
const model = (x: number[]) => x.reduce((s, v, j) => s + v * w[j], 0);
const loud = (x: number[]) => x[0];
const groups: [string, (r: MapRow) => boolean][] = [
  ['all', () => true], ['4K', (r) => r.keys === 4], ['6K', (r) => r.keys === 6], ['7K', (r) => r.keys === 7],
  ['< 4 stars', (r) => r.stars < 4], ['4-6 stars', (r) => r.stars >= 4 && r.stars < 6], ['6+ stars', (r) => r.stars >= 6],
];
console.log(`${new Set(rows.map((r) => r.id)).size} songs, ${rows.length} maps (${train.length} train / ${test.length} held out)`);
console.log('held-out maps: correlation of the predicted curve with the ranked map\'s density per measure');
for (const [name, f] of groups) {
  const t = test.filter(f);
  console.log(`  ${name.padEnd(10)} ${String(t.length).padStart(4)} maps   loudness ${score(t, loud).toFixed(3)}   learned ${score(t, model).toFixed(3)}`);
}
console.log('weights:', ENERGY_FEATURES.map((n, j) => `${n} ${w[j].toFixed(3)}`).join(', '));
if (!argv.includes('--dry')) {
  const note = `trained on ${train.length} ranked maps (${keysOk.join('/')}K); held-out correlation with ranked density ${score(test, model).toFixed(3)} (loudness alone ${score(test, loud).toFixed(3)})`;
  writeFileSync('src/automap/energymodel.ts', `/** Learned music-energy curve (ridge regression per measure); regenerated by scripts/bench/train-energy-model.ts. */
export interface EnergyModel { w: number[]; note: string }
// features: ${ENERGY_FEATURES.join(', ')}
export const ENERGY_MODEL: EnergyModel | null = ${JSON.stringify({ w: w.map((v) => +v.toFixed(5)), note })};
`);
  console.log(`wrote src/automap/energymodel.ts (${note})`);
}
