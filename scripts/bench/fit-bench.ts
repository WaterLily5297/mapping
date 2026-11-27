/**
 * Star adjustment against human difficulty spreads: in a ranked mapset, adjust a harder
 * difficulty down to an easier one's stars (and the easier one up to the harder one's) and compare
 * the result with the difficulty the mapper actually made.
 *
 *   npx tsx scripts/bench/fit-bench.ts DATA_DIR [--keys 7] [--songs 20] [--gap 1] [--loudness W]
 *
 * Per pair (harder H, easier E, at least --gap stars apart, rice maps with one red line):
 *   down: fitDifficulty(H, stars(E)) vs E      up: fitDifficulty(E, stars(H)) vs H
 * Metrics against the human map: star error, rhythm F1 (rows within 25 ms), density contour r
 * (notes per measure) and how much density follows the song's loudness (the human map's value
 * for reference). --loudness W makes the adjustment contrast-aware with weight W.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, getKeys, isLN, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze } from '../../src/automap/analysis';
import { loudnessEnvelope, energyEnvelope, contrastSourceFor, _setContrastSource } from '../../src/automap/generate';
import { starRating } from '../../src/analysis/difficulty';
import { fitDifficulty } from '../../src/tools/difficultyfit';
import { measureContour, pearson } from './contour';

const argv = process.argv.slice(2);
// --contrast-source energy|loudness
{ const i = argv.indexOf('--contrast-source'); if (i >= 0) _setContrastSource(argv[i + 1] as 'auto' | 'energy' | 'loudness'); }
const dataDir = argv[0];
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const keys = Number(opt('keys', '7')), nSongs = Number(opt('songs', '20')), gap = Number(opt('gap', '1'));
const weight = Number(opt('loudness', '0')), peakW = opt('peak', '');

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}
const rowTimes = (m: Beatmap) => [...new Set(m.notes.map((n) => n.time))].sort((x, y) => x - y);
function f1(gen: Beatmap, ref: Beatmap) {
  const a = rowTimes(gen), b = rowTimes(ref);
  let i = 0, j = 0, hit = 0;
  while (i < a.length && j < b.length) { const d = a[i] - b[j]; if (Math.abs(d) <= 25) { hit++; i++; j++; } else if (d < 0) i++; else j++; }
  const p = hit / Math.max(1, a.length), r = hit / Math.max(1, b.length);
  return p + r ? (2 * p * r) / (p + r) : 0;
}

type Acc = { n: number; err: number; f1: number; contour: number; loud: number; humanLoud: number };
const acc: Record<'down' | 'up', Acc> = { down: { n: 0, err: 0, f1: 0, contour: 0, loud: 0, humanLoud: 0 }, up: { n: 0, err: 0, f1: 0, contour: 0, loud: 0, humanLoud: 0 } };
let songs = 0;
for (const set of readdirSync(dataDir).sort()) {
  if (songs >= nSongs) break;
  const dir = join(dataDir, set);
  if (!statSync(dir).isDirectory()) continue;
  const files = readdirSync(dir);
  const audio = files.find((f) => /^audio\./.test(f));
  if (!audio) continue;
  const maps = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter((m): m is Beatmap => !!m && getKeys(m) === keys && redLines(m).length === 1 && m.notes.length > 100 && m.notes.filter(isLN).length / m.notes.length < 0.2)
    .map((m) => ({ m, s: starRating(m).stars })).sort((a, b) => a.s - b.s);
  // the same timing in both maps, so measures line up
  const pairs: [typeof maps[0], typeof maps[0]][] = [];
  for (let i = 0; i < maps.length; i++) for (let j = i + 1; j < maps.length; j++) {
    const ra = redLines(maps[i].m)[0], rb = redLines(maps[j].m)[0];
    if (maps[j].s - maps[i].s >= gap && Math.abs(ra.beatLength - rb.beatLength) < 0.5) pairs.push([maps[i], maps[j]]);
  }
  if (!pairs.length) continue;
  songs++;
  const a = analyze(decode(join(dir, audio)), 22050);
  const red = redLines(pairs[0][0].m)[0];
  const env = contrastSourceFor(getKeys(pairs[0][0].m)) === 'energy' ? energyEnvelope(a, pairs[0][0].m) : loudnessEnvelope(a, red.beatLength * 4);
  const loudAt = (t: number) => env[Math.max(0, Math.min(env.length - 1, Math.round(t / 1000 / a.frameDur)))] ?? 0;
  const fitOpts = weight ? { loudness: loudAt, loudnessWeight: weight, ...(peakW ? { peakWeight: Number(peakW) } : {}) } : {};
  for (const [E, H] of pairs.slice(0, 2)) {
    for (const [dirn, src, human] of [['down', H, E], ['up', E, H]] as const) {
      const r = fitDifficulty(src.m, human.s, { seed: 3, ...fitOpts });
      const t0 = Math.min(...human.m.notes.map((n) => n.time)), t1 = Math.max(...human.m.notes.map((n) => n.time));
      const G = measureContour(r.map, a, red.beatLength, red.time, t0, t1), Hc = measureContour(human.m, a, red.beatLength, red.time, t0, t1);
      const x = acc[dirn];
      x.n++; x.err += Math.abs(r.stars - human.s); x.f1 += f1(r.map, human.m);
      x.contour += pearson(G.dens, Hc.dens); x.loud += pearson(G.dens, Hc.loud); x.humanLoud += pearson(Hc.dens, Hc.loud);
    }
  }
}
for (const d of ['down', 'up'] as const) {
  const x = acc[d], m = (v: number) => (v / Math.max(1, x.n)).toFixed(3);
  console.log(`${d.padEnd(5)} ${x.n} pairs: starErr ${m(x.err)}  rhythmF1 vs human ${m(x.f1)}  contour r vs human ${m(x.contour)}  density~loudness ${m(x.loud)} (human ${m(x.humanLoud)})`);
}
