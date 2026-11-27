/**
 * Quick rules: does keeping the best of several seeds by the quality score give charts closer to
 * the ranked maps than one seed? Per held-out song, N seeds at the ranked map's stars and timing.
 *
 *   npx tsx scripts/bench/qr-rerank.ts DATA_DIR --keys 7 [--songs 12] [--seeds 6] [--min-stars 0]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, getKeys, isLN, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze, detectOnsets } from '../../src/automap/analysis';
import { generateForStars } from '../../src/automap/target';
import { starRating } from '../../src/analysis/difficulty';
import { classifyPatterns } from '../../src/analysis/patterns';
import { dirt } from '../../src/tools/cleanliness';
import { chartQuality, type QualityParts } from '../../src/automap/quality';

const argv = process.argv.slice(2);
const dataDir = argv[0];
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const keys = Number(opt('keys', '7')), nSongs = Number(opt('songs', '12')), nSeeds = Number(opt('seeds', '6')), minStars = Number(opt('min-stars', '0'));
function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}
const rowsOf = (m: Beatmap) => [...new Set(m.notes.map((n) => n.time))].sort((x, y) => x - y);
const f1 = (g: Beatmap, r: Beatmap) => { const a = rowsOf(g), b = rowsOf(r); let i = 0, j = 0, h = 0; while (i < a.length && j < b.length) { const d = a[i] - b[j]; if (Math.abs(d) <= 25) { h++; i++; j++; } else if (d < 0) i++; else j++; } const p = h / Math.max(1, a.length), q = h / Math.max(1, b.length); return p + q ? 2 * p * q / (p + q) : 0; };
const SK = ['Stream', 'Jumpstream', 'Handstream', 'Chordstream', 'Jackspeed', 'Chordjack', 'Technical', 'LN', 'Slow'];
const sk = (m: Beatmap) => { const g = classifyPatterns(m).byGroup as Record<string, number>; const v = SK.map((k) => g[k] ?? 0); const s = v.reduce((x, y) => x + y, 0) || 1; return v.map((x) => x / s); };
const tv = (a: number[], b: number[]) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / 2;

interface Cand { f1: number; skill: number; dirt: number; starErr: number; q: QualityParts; total: number }
const songs: Cand[][] = [];
for (const set of readdirSync(dataDir).sort()) {
  if (songs.length >= nSongs) break;
  const dir = join(dataDir, set);
  if (!statSync(dir).isDirectory()) continue;
  const files = readdirSync(dir), audio = files.find((f) => /^audio\./.test(f));
  if (!audio) continue;
  const c = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter((m): m is Beatmap => !!m && getKeys(m) === keys && redLines(m).length === 1 && m.notes.filter(isLN).length / Math.max(1, m.notes.length) < 0.2)
    .map((m) => ({ m, s: starRating(m).stars }));
  if (!c.length) continue;
  if (minStars > 0) { c.sort((a, b) => b.s - a.s); if (c[0].s < minStars) continue; } else c.sort((a, b) => Math.abs(a.s - 4) - Math.abs(b.s - 4));
  const { m: ref, s: target } = c[0];
  const red = redLines(ref)[0];
  const a = analyze(decode(join(dir, audio)), 22050);
  const onsets = detectOnsets(a, 0.6);
  const refSk = sk(ref);
  const cands: Cand[] = [];
  for (let seed = 1; seed <= nSeeds; seed++) {
    const g = generateForStars(a, { keys, targetStars: target, bpm: 60000 / red.beatLength, offset: red.time, seed, lnRatio: 0, style: 'auto' });
    const q = chartQuality(g.map, a, target, { onsets });
    cands.push({ f1: f1(g.map, ref), skill: tv(sk(g.map), refSk), dirt: dirt(g.map).score, starErr: Math.abs(g.stars - target), q: q.parts, total: q.total });
  }
  songs.push(cands);
  process.stdout.write(`\r${songs.length} songs`);
}
console.log('');
const avg = (f: (c: Cand[]) => number) => songs.reduce((s, c) => s + f(c), 0) / Math.max(1, songs.length);
const mean = (c: Cand[], k: 'f1' | 'skill' | 'dirt' | 'starErr') => c.reduce((s, x) => s + x[k], 0) / c.length;
const pickBy = (score: (c: Cand) => number) => (c: Cand[]) => c.reduce((a, b) => (score(b) > score(a) ? b : a));
const line = (name: string, f1v: number, sv: number, dv: number, ev: number) => console.log(`${name.padEnd(20)} F1 ${f1v.toFixed(3)}  skill-mix ${sv.toFixed(3)}  dirt ${dv.toFixed(1)}  starErr ${ev.toFixed(3)}`);
const report = (name: string, pick: (c: Cand[]) => Cand) => line(name, avg((c) => pick(c).f1), avg((c) => pick(c).skill), avg((c) => pick(c).dirt), avg((c) => pick(c).starErr));
console.log(`${keys}K, ${songs.length} songs x ${nSeeds} seeds${minStars ? `, ${minStars}+ stars` : ''}`);
console.log(`spread within a song (best - worst): F1 ${avg((c) => Math.max(...c.map((x) => x.f1)) - Math.min(...c.map((x) => x.f1))).toFixed(3)}, skill-mix ${avg((c) => Math.max(...c.map((x) => x.skill)) - Math.min(...c.map((x) => x.skill))).toFixed(3)}`);
line('one seed (average)', avg((c) => mean(c, 'f1')), avg((c) => mean(c, 'skill')), avg((c) => mean(c, 'dirt')), avg((c) => mean(c, 'starErr')));
report('score (all parts)', pickBy((c) => c.total));
for (let k = 2; k < nSeeds; k++) report(`score, best of ${k}`, (c) => pickBy((x) => x.total)(c.slice(0, k)));
for (const k of ['stars', 'onBeat', 'energy', 'filled', 'clean'] as (keyof QualityParts)[]) report(`score: ${k}`, pickBy((c) => c.q[k]));
report('oracle (best F1)', pickBy((c) => c.f1));
