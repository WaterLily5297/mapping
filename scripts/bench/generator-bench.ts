/**
 * Generator benchmark: generate a chart for songs that have ranked osu!mania maps and compare.
 *
 *   npx tsx scripts/bench/generator-bench.ts DATA_DIR [--max 40] [--keys 4,7] [--json out.json]
 *
 * DATA_DIR holds song folders (audio.* + .osu files), e.g. the output of `maniamap data-fetch`.
 * For each song one rice difficulty (LN < 20%) is picked; the generator gets the same key count,
 * the ranked map's timing (so tempo detection errors do not hide generator quality) and its star
 * rating as target. Metrics:
 *   starErr     |generated stars - ranked stars|
 *   rhythmF1    rows at the same times (+-25 ms) as the ranked map, F1 over rows
 *   chordTV     total variation distance of chord-size distributions (0 same .. 1 disjoint)
 *   skillTV     total variation distance of skill-group time shares (stream, jumpstream, jacks, ...)
 *   dirt        dirt score per 1000 notes (fast jacks, hand overload, ...); ranked maps for reference
 *   repeat      how often a repeated rhythm (same 1-beat onset pattern) gets the same column shape
 *               within 8 beats, as in human maps (pattern consistency)
 * Lower is better except rhythmF1 and repeat (closer to the ranked value is better).
 * --min-stars X benchmarks each song's hardest difficulty instead (songs with one of X stars or more).
 * --contrast X sets the loudness contrast strength (see scripts/bench/contour.ts).
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, getKeys, isLN, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze } from '../../src/automap/analysis';
import { generateForStars } from '../../src/automap/target';
import { starRating } from '../../src/analysis/difficulty';
import { classifyPatterns } from '../../src/analysis/patterns';
import { dirt } from '../../src/tools/cleanliness';

const argv = process.argv.slice(2);
const dataDir = argv[0];
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const max = Number(opt('max') ?? 40);
const keysFilter = (opt('keys') ?? '4,7').split(',').map(Number);
const style = opt('style');

function decode(path: string, sr: number): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

const rowTimes = (m: Beatmap) => [...new Set(m.notes.map((n) => n.time))].sort((a, b) => a - b);

function rhythmF1(gen: Beatmap, ref: Beatmap): number {
  const a = rowTimes(gen), b = rowTimes(ref);
  let i = 0, j = 0, hit = 0;
  while (i < a.length && j < b.length) {
    const d = a[i] - b[j];
    if (Math.abs(d) <= 25) { hit++; i++; j++; } else if (d < 0) i++; else j++;
  }
  const p = hit / Math.max(1, a.length), r = hit / Math.max(1, b.length);
  return p + r ? (2 * p * r) / (p + r) : 0;
}

function chordDist(m: Beatmap): number[] {
  const rows = new Map<number, number>();
  for (const n of m.notes) rows.set(n.time, (rows.get(n.time) ?? 0) + 1);
  const d = new Array(19).fill(0);
  for (const c of rows.values()) d[Math.min(18, c)]++;
  const s = d.reduce((x, y) => x + y, 0) || 1;
  return d.map((x) => x / s);
}

const tv = (a: number[], b: number[]) => a.reduce((s, x, i) => s + Math.abs(x - (b[i] ?? 0)), 0) / 2;

function skillVec(m: Beatmap): number[] {
  const g = classifyPatterns(m).byGroup;
  const keys = ['Stream', 'Jumpstream', 'Handstream', 'Chordstream', 'Jackspeed', 'Chordjack', 'Technical', 'LN', 'Slow'] as const;
  const v = keys.map((k) => g[k] ?? 0);
  const s = v.reduce((x, y) => x + y, 0) || 1;
  return v.map((x) => x / s);
}

/** pattern consistency: for 1-beat windows with the same rhythm (relative row times + chord sizes)
 *  within the next 8 beats, how often is the column shape the same (or mirrored)? */
export function repetition(m: Beatmap): number {
  const red = redLines(m)[0];
  if (!red) return 0;
  const beat = red.beatLength, K = getKeys(m);
  const rows = new Map<number, number[]>();
  for (const n of m.notes) rows.set(n.time, [...(rows.get(n.time) ?? []), n.column]);
  const times = [...rows.keys()].sort((a, b) => a - b);
  const windows = new Map<number, { rhythm: string; shape: string; mirror: string }>();
  for (const t of times) {
    const w = Math.floor((t - red.time) / beat + 1e-6);
    const rel = Math.round(((t - red.time) / beat - w) * 48);
    const cols = rows.get(t)!.sort((a, b) => a - b);
    const e = windows.get(w) ?? { rhythm: '', shape: '', mirror: '' };
    e.rhythm += `${rel}:${cols.length},`;
    e.shape += `${cols.join('.')}|`;
    e.mirror += `${cols.map((c) => K - 1 - c).sort((a, b) => a - b).join('.')}|`;
    windows.set(w, e);
  }
  let same = 0, total = 0;
  for (const [w, e] of windows) {
    if (e.rhythm.split(',').length < 3) continue; // need 2+ rows in the beat
    for (let d = 1; d <= 8; d++) {
      const o = windows.get(w + d);
      if (o && o.rhythm === e.rhythm) { total++; if (o.shape === e.shape || o.shape === e.mirror) same++; break; }
    }
  }
  return total ? same / total : 0;
}

/** the style a mapper would name for this ranked map (from its skill mix) */
function oracleStyle(m: Beatmap): 'stream' | 'jumpstream' | 'chordjack' | 'tech' | 'balanced' {
  const g = classifyPatterns(m).byGroup;
  const v = (k: string) => (g as Record<string, number>)[k] ?? 0;
  const best = [
    ['chordjack', v('Chordjack') + v('Jackspeed')], ['stream', v('Stream')], ['jumpstream', v('Jumpstream') + v('Handstream')],
    ['tech', v('Technical') * 2],
  ].sort((a, b) => (b[1] as number) - (a[1] as number))[0];
  return (best[1] as number) > 0.3 ? best[0] as never : 'balanced';
}

interface Row { song: string; keys: number; target: number; stars: number; starErr: number; rhythmF1: number; chordTV: number; skillTV: number; dirt: number; refDirt: number; repeat: number; refRepeat: number; ms: number; skills: number[]; refSkills: number[] }

const rows: Row[] = [];
const sets = readdirSync(dataDir).filter((d) => existsSync(join(dataDir, d))).sort();
const holdout = Number(opt('holdout') ?? 0);
for (const [setIdx, set] of sets.entries()) {
  if (rows.length >= max) break;
  if (holdout && setIdx % holdout !== 0) continue; // only songs the style model did not see
  const dir = join(dataDir, set);
  let files: string[];
  try { files = readdirSync(dir); } catch { continue; }
  const audio = files.find((f) => /^audio\./.test(f));
  if (!audio) continue;
  const cands: { m: Beatmap; s: number }[] = [];
  for (const f of files.filter((x) => x.endsWith('.osu'))) {
    try {
      const m = parseOsu(readFileSync(join(dir, f), 'utf8'));
      if (!keysFilter.includes(getKeys(m)) || redLines(m).length !== 1) continue;
      if (m.notes.filter(isLN).length / Math.max(1, m.notes.length) > 0.2) continue;
      cands.push({ m, s: starRating(m).stars });
    } catch { /* skip */ }
  }
  if (!cands.length) continue;
  // --min-stars X: the song's hardest difficulty, if it is at least X stars (high-difficulty slice);
  // otherwise the difficulty closest to 3.5 stars (most common range)
  const minStars = opt('min-stars');
  if (minStars !== undefined) {
    cands.sort((a, b) => b.s - a.s);
    if (cands[0].s < Number(minStars)) continue;
  } else cands.sort((a, b) => Math.abs(a.s - 3.5) - Math.abs(b.s - 3.5));
  const { m: ref, s: target } = cands[0];
  const t0 = performance.now();
  const a = analyze(decode(join(dir, audio), 22050), 22050);
  const red = redLines(ref)[0];
  const r = generateForStars(a, {
    keys: getKeys(ref), targetStars: target, bpm: 60000 / red.beatLength, offset: red.time, seed: 7, lnRatio: 0,
    ...(style === 'oracle' ? { style: oracleStyle(ref) } : style ? { style: style as never } : {}),
    ...(argv.includes('--coarse') ? { fineGrid: false } : argv.includes('--fine') ? { fineGrid: true } : {}),
    // --contrast X: loudness contrast strength (default: defaultContrast(stars))
    ...(opt('contrast') !== undefined ? { contrast: Number(opt('contrast')) } : {}),
  });
  const ms = performance.now() - t0;
  const row: Row = {
    song: set.slice(0, 40), keys: getKeys(ref), target, stars: r.stars, starErr: Math.abs(r.stars - target),
    rhythmF1: rhythmF1(r.map, ref), chordTV: tv(chordDist(r.map), chordDist(ref)), skillTV: tv(skillVec(r.map), skillVec(ref)),
    skills: skillVec(r.map), refSkills: skillVec(ref),
    dirt: dirt(r.map).score, refDirt: dirt(ref).score, repeat: repetition(r.map), refRepeat: repetition(ref), ms,
  };
  (row as Row & { style?: string }).style = style === 'oracle' ? oracleStyle(ref) : style ?? 'balanced';
  rows.push(row);
  console.log(`${row.keys}K ${row.target.toFixed(2)}* -> ${row.stars.toFixed(2)}  F1 ${row.rhythmF1.toFixed(2)}  chordTV ${row.chordTV.toFixed(2)}  skillTV ${row.skillTV.toFixed(2)}  dirt ${row.dirt.toFixed(0)} (ref ${row.refDirt.toFixed(0)})  repeat ${row.repeat.toFixed(2)} (ref ${row.refRepeat.toFixed(2)})  ${(ms / 1000).toFixed(1)}s  ${row.song}`);
}

const mean = (k: keyof Row) => rows.reduce((s, r) => s + (r[k] as number), 0) / Math.max(1, rows.length);
console.log(`\n${rows.length} songs`);
console.log(`starErr ${mean('starErr').toFixed(3)}  rhythmF1 ${mean('rhythmF1').toFixed(3)}  chordTV ${mean('chordTV').toFixed(3)}  skillTV ${mean('skillTV').toFixed(3)}  dirt ${mean('dirt').toFixed(1)} (ranked ${mean('refDirt').toFixed(1)})  repeat ${mean('repeat').toFixed(3)} (ranked ${mean('refRepeat').toFixed(3)})`);
const SK = ['Stream', 'Jumpstream', 'Handstream', 'Chordstream', 'Jackspeed', 'Chordjack', 'Technical', 'LN', 'Slow'];
const avg = (k: 'skills' | 'refSkills') => SK.map((_, i) => rows.reduce((s, r) => s + r[k][i], 0) / Math.max(1, rows.length));
console.log('skill mix      ' + SK.map((n) => n.slice(0, 9).padStart(10)).join(''));
console.log('  generated    ' + avg('skills').map((x) => x.toFixed(2).padStart(10)).join(''));
console.log('  ranked       ' + avg('refSkills').map((x) => x.toFixed(2).padStart(10)).join(''));
const out = opt('json');
if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
