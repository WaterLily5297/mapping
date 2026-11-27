/**
 * Contrast / tension envelope: does the chart's density follow the song's intensity the way the
 * ranked map does?
 *
 *   npx tsx scripts/bench/contour.ts DATA_DIR [--keys 7] [--songs 12] [--holdout 3] [--min-stars 0]
 *
 * Per measure (4 beats) over the ranked map's span: notes in the ranked map, notes in maniamap's
 * chart (quick rules, ranked timing, the ranked map's stars) and the song's loudness and onset
 * strength. Prints the correlation of the chart's density with the ranked map's (does it rise and
 * fall in the same places?) and the contrast: the spread of density between quiet and loud
 * measures, as a ratio to the ranked map's spread.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, getKeys, isLN, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze, type Analysis } from '../../src/automap/analysis';
import { generateForStars } from '../../src/automap/target';
import { _setContrastSource } from '../../src/automap/generate';
import { starRating } from '../../src/analysis/difficulty';

const argv = process.argv.slice(2);
// --contrast-source energy|loudness
{ const i = argv.indexOf('--contrast-source'); if (i >= 0) _setContrastSource(argv[i + 1] as 'energy' | 'loudness'); }
const dataDir = argv[0];
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const contrast = opt('contrast', '') === '' ? undefined : Number(opt('contrast', '0'));
// --train: score the training songs (the complement of the held-out ones) to tune --contrast
const train = argv.includes('--train');
const keys = Number(opt('keys', '7')), nSongs = Number(opt('songs', '12')), holdout = Number(opt('holdout', '3')), minStars = Number(opt('min-stars', '0'));

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}
export function pearson(x: number[], y: number[]) {
  const n = x.length; if (n < 3) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
/** coefficient of variation: how much density changes between measures */
const cv = (x: number[]) => { const m = x.reduce((a, b) => a + b, 0) / x.length; return m ? Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length) / m : 0; };

export function measureContour(m: Beatmap, a: Analysis | null, beatLen: number, offset: number, t0: number, t1: number) {
  const bar = beatLen * 4, first = Math.floor((t0 - offset) / bar), last = Math.floor((t1 - offset) / bar);
  const dens: number[] = [], loud: number[] = [], onset: number[] = [];
  for (let k = first; k <= last; k++) {
    const s = offset + k * bar, e = s + bar;
    dens.push(m.notes.filter((n) => n.time >= s && n.time < e).length);
    if (a) {
      const f0 = Math.max(0, Math.floor(s / 1000 / a.frameDur)), f1 = Math.min(a.rms.length, Math.ceil(e / 1000 / a.frameDur));
      let r = 0, f = 0; for (let i = f0; i < f1; i++) { r += a.rms[i]; f += a.flux[i]; }
      loud.push(r / Math.max(1, f1 - f0)); onset.push(f / Math.max(1, f1 - f0));
    }
  }
  return { dens, loud, onset };
}

if (/[\\/]contour\.ts$/.test(process.argv[1] ?? '')) {
  const acc = { n: 0, rGen: 0, rRefLoud: 0, rGenLoud: 0, rRefOnset: 0, rGenOnset: 0, contrast: 0 };
  for (const [idx, set] of readdirSync(dataDir).sort().entries()) {
    if (acc.n >= nSongs) break;
    if (train ? idx % holdout === 0 : idx % holdout !== 0) continue;
    const dir = join(dataDir, set);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir);
    const audio = files.find((f) => /^audio\./.test(f));
    if (!audio) continue;
    const c = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
      .filter((m): m is Beatmap => !!m && getKeys(m) === keys && redLines(m).length === 1 && m.notes.filter(isLN).length / Math.max(1, m.notes.length) < 0.2)
      .map((m) => ({ m, s: starRating(m).stars }));
    if (!c.length) continue;
    if (minStars > 0) { c.sort((a, b) => b.s - a.s); if (c[0].s < minStars) continue; } else c.sort((a, b) => Math.abs(a.s - 4) - Math.abs(b.s - 4));
    const { m: ref, s: stars } = c[0];
    const red = redLines(ref)[0];
    const a = analyze(decode(join(dir, audio)), 22050);
    const gen = generateForStars(a, { keys, targetStars: stars, bpm: 60000 / red.beatLength, offset: red.time, seed: 7, lnRatio: 0, style: 'auto', contrast }).map;
    const t0 = Math.min(...ref.notes.map((n) => n.time)), t1 = Math.max(...ref.notes.map((n) => n.time));
    const R = measureContour(ref, a, red.beatLength, red.time, t0, t1), G = measureContour(gen, null, red.beatLength, red.time, t0, t1);
    const row = { rGen: pearson(G.dens, R.dens), rRefLoud: pearson(R.dens, R.loud), rGenLoud: pearson(G.dens, R.loud), rRefOnset: pearson(R.dens, R.onset), rGenOnset: pearson(G.dens, R.onset), contrast: cv(G.dens) / Math.max(1e-9, cv(R.dens)) };
    acc.n++; for (const k of Object.keys(row) as (keyof typeof row)[]) acc[k] += row[k];
    console.log(`${set.slice(0, 36).padEnd(36)} ${stars.toFixed(2)}*  density r=${row.rGen.toFixed(2)}  ranked~loudness ${row.rRefLoud.toFixed(2)} ours ${row.rGenLoud.toFixed(2)}  ranked~onsets ${row.rRefOnset.toFixed(2)} ours ${row.rGenOnset.toFixed(2)}  contrast ${row.contrast.toFixed(2)}x`);
  }
  const m = (k: keyof typeof acc) => (acc[k] / Math.max(1, acc.n)).toFixed(3);
  console.log(`\n${acc.n} songs: density contour r=${m('rGen')} vs ranked; density~loudness ranked ${m('rRefLoud')} / ours ${m('rGenLoud')}; density~onsets ranked ${m('rRefOnset')} / ours ${m('rGenOnset')}; contrast ${m('contrast')}x of ranked`);
}
