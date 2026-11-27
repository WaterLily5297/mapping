/**
 * Empty and thin parts: where does a generated chart leave the music without notes, compared with
 * the ranked map of the same song?
 *
 *   npx tsx scripts/bench/gaps.ts DATA_DIR [--keys 7] [--songs 12] [--holdout 3] [--min-stars 0] [--tempo ranked|detect] [--style auto]
 *       [--maps DIR]   score charts made elsewhere (DIR/<idx>.osu, e.g. full-song AI output) instead of generating
 *
 * Per song, over the ranked map's span (first to last note), in measures of 4 beats:
 *   empty: measures where the ranked map has 4+ notes and the chart has none
 *   thin:  measures where the chart has under 30% of the ranked map's notes
 *   gap:   the chart's longest stretch without a note, against the ranked map's
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, getKeys, isLN, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze, estimateTempo } from '../../src/automap/analysis';
import { generateForStars } from '../../src/automap/target';
import { starRating } from '../../src/analysis/difficulty';
import type { StyleChoice } from '../../src/automap/generate';

const argv = process.argv.slice(2);
const dataDir = argv[0];
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const keys = Number(opt('keys', '7')), nSongs = Number(opt('songs', '12')), holdout = Number(opt('holdout', '3'));
const minStars = Number(opt('min-stars', '0')), tempoMode = opt('tempo', 'ranked'), mapsDir = opt('maps', '');
const style = opt('style', 'auto') as StyleChoice;

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

export function gapStats(gen: Beatmap, ref: Beatmap, beatLen: number, offset: number) {
  const rt = ref.notes.map((n) => n.time).sort((a, b) => a - b);
  const gt = gen.notes.map((n) => n.time).sort((a, b) => a - b);
  const t0 = rt[0], t1 = rt[rt.length - 1];
  const bar = beatLen * 4;
  const first = Math.floor((t0 - offset) / bar), last = Math.floor((t1 - offset) / bar);
  const count = (ts: number[], a: number, b: number) => { let n = 0; for (const t of ts) if (t >= a && t < b) n++; return n; };
  let active = 0, empty = 0, thin = 0;
  const emptyAt: number[] = [];
  for (let m = first; m <= last; m++) {
    const a = offset + m * bar, b = a + bar;
    const r = count(rt, a, b);
    if (r < 4) continue;
    active++;
    const g = count(gt, a, b);
    if (g === 0) { empty++; emptyAt.push(a); }
    if (g < 0.3 * r) thin++;
  }
  const longest = (ts: number[]) => { let best = 0; const s = [t0, ...ts.filter((t) => t >= t0 && t <= t1), t1]; for (let i = 1; i < s.length; i++) best = Math.max(best, s[i] - s[i - 1]); return best; };
  return { active, empty, thin, gapGen: longest(gt), gapRef: longest(rt), emptyAt, density: gt.filter((t) => t >= t0 && t <= t1).length / Math.max(1, rt.length) };
}

if (/[\/]gaps.ts$/.test(process.argv[1] ?? '')) {
  const sets = readdirSync(dataDir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name).sort();
  const tot = { songs: 0, active: 0, empty: 0, thin: 0, gapGen: 0, gapRef: 0, density: 0 };
  for (const [idx, set] of sets.entries()) {
    if (tot.songs >= nSongs) break;
    if (idx % holdout !== 0) continue;
    const dir = join(dataDir, set);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir);
    const audio = files.find((f) => /^audio\./.test(f));
    if (!audio) continue;
    const cands = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
      .filter((m): m is Beatmap => !!m && getKeys(m) === keys && redLines(m).length === 1 && m.notes.filter(isLN).length / Math.max(1, m.notes.length) < 0.2)
      .map((m) => ({ m, s: starRating(m).stars }));
    if (!cands.length) continue;
    if (minStars > 0) { cands.sort((a, b) => b.s - a.s); if (cands[0].s < minStars) continue; } else cands.sort((a, b) => Math.abs(a.s - 4) - Math.abs(b.s - 4));
    const { m: ref, s: stars } = cands[0];
    const red = redLines(ref)[0];
    let gen: Beatmap;
    if (mapsDir) {
      const p = join(mapsDir, `${idx}.osu`);
      if (!existsSync(p)) continue;
      gen = parseOsu(readFileSync(p, 'utf8'));
    } else {
      const a = analyze(decode(join(dir, audio)), 22050);
      const tempo = tempoMode === 'detect' ? estimateTempo(a) : { bpm: 60000 / red.beatLength, offset: red.time };
      gen = generateForStars(a, { keys, targetStars: stars, bpm: tempo.bpm, offset: tempo.offset, seed: 7, lnRatio: 0, style }).map;
    }
    const g = gapStats(gen, ref, red.beatLength, red.time);
    tot.songs++; tot.active += g.active; tot.empty += g.empty; tot.thin += g.thin; tot.gapGen += g.gapGen; tot.gapRef += g.gapRef; tot.density += g.density;
    const where = g.emptyAt.slice(0, 4).map((t) => `${Math.floor(t / 60000)}:${String(Math.floor(t / 1000) % 60).padStart(2, '0')}`).join(' ');
    console.log(`${set.slice(0, 38).padEnd(38)} ${stars.toFixed(2)}*  empty ${String(g.empty).padStart(3)}/${String(g.active).padEnd(3)} thin ${String(g.thin).padStart(3)}  gap ${(g.gapGen / 1000).toFixed(1)}s (ranked ${(g.gapRef / 1000).toFixed(1)}s)  notes ${(g.density * 100).toFixed(0)}%  ${where}`);
  }
  const n = Math.max(1, tot.songs);
  console.log(`\n${tot.songs} songs: empty measures ${(100 * tot.empty / Math.max(1, tot.active)).toFixed(1)}%, thin ${(100 * tot.thin / Math.max(1, tot.active)).toFixed(1)}%, longest gap ${(tot.gapGen / n / 1000).toFixed(1)}s (ranked ${(tot.gapRef / n / 1000).toFixed(1)}s), notes ${(100 * tot.density / n).toFixed(0)}% of ranked`);
}
