/**
 * Long notes against ranked LN maps: given a ranked LN map turned into short notes, which notes
 * does maniamap make long, and where do they end?
 *
 *   npx tsx scripts/bench/ln-bench.ts DATA_DIR [DATA_DIR...] [--songs 40] [--heldout-id] [--method current|model]
 *
 * Ranked maps with 25%+ long notes and one red line. Each map's notes lose their tails; the method
 * adds long notes for the same share of notes as the ranked map. Scores:
 *   heads   precision / recall / F1 of "this note is long" against the ranked map
 *   tails   for notes both made long: share whose end is within 1/8 and 1/4 beat of the ranked
 *           end, and the median error in beats
 * --heldout-id keeps songs with beatmap set id % 3 == 0 (the LN model's test songs).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, cloneBeatmap, isLN, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze } from '../../src/automap/analysis';
import { addLongNotes } from '../../src/automap/generate';
import { placeLongNotes } from '../../src/automap/longnotes';
import { rng } from '../../src/core/rng';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--songs', '--method'].includes(argv[i - 1])));
const nSongs = Number(opt('songs', '40')), method = opt('method', 'current');

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

const acc = { maps: 0, tp: 0, fp: 0, fn: 0, tails: 0, t8: 0, t4: 0, errs: [] as number[] };
const seen = new Set<number>();
outer: for (const dir of dirs) for (const set of readdirSync(dir).sort()) {
  if (seen.size >= nSongs) break outer;
  const p = join(dir, set);
  if (!statSync(p).isDirectory()) continue;
  const id = Number(set.split(' ')[0]);
  if (!Number.isFinite(id) || seen.has(id)) continue;
  if (argv.includes('--heldout-id') && id % 3 !== 0) continue;
  const files = readdirSync(p), audio = files.find((f) => /^audio\./.test(f));
  if (!audio) continue;
  const maps = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(p, f), 'utf8')); } catch { return null; } })
    .filter((m): m is Beatmap => !!m && m.notes.length > 100 && redLines(m).length === 1 && m.notes.filter(isLN).length / m.notes.length >= 0.25);
  if (!maps.length) continue;
  seen.add(id);
  const a = analyze(decode(join(p, audio)), 22050);
  for (const ref of maps.slice(0, 2)) {
    const red = redLines(ref)[0], beat = red.beatLength;
    const share = ref.notes.filter(isLN).length / ref.notes.length;
    const rice = cloneBeatmap(ref);
    rice.notes = ref.notes.map((n) => ({ time: n.time, column: n.column }));
    if (method === 'model') placeLongNotes(rice, a, share);
    else addLongNotes(rice, rice.notes, a, beat, 4, share, rng(5));
    const key = (n: { time: number; column: number }) => `${n.time}:${n.column}`;
    const refLN = new Map(ref.notes.filter(isLN).map((n) => [key(n), n.endTime!]));
    acc.maps++;
    for (const n of rice.notes) {
      const want = refLN.get(key(n));
      if (isLN(n) && want !== undefined) {
        acc.tp++;
        const e = Math.abs(n.endTime! - want) / beat;
        acc.tails++; acc.errs.push(e); if (e <= 1 / 8 + 1e-6) acc.t8++; if (e <= 1 / 4 + 1e-6) acc.t4++;
      } else if (isLN(n)) acc.fp++;
      else if (want !== undefined) acc.fn++;
    }
  }
  process.stdout.write(`\r${seen.size} songs, ${acc.maps} maps`);
}
console.log('');
const P = acc.tp / Math.max(1, acc.tp + acc.fp), R = acc.tp / Math.max(1, acc.tp + acc.fn);
acc.errs.sort((x, y) => x - y);
console.log(`${method}: ${acc.maps} LN maps; heads precision ${P.toFixed(3)} recall ${R.toFixed(3)} F1 ${(2 * P * R / Math.max(1e-9, P + R)).toFixed(3)}; tails within 1/8 beat ${(acc.t8 / Math.max(1, acc.tails)).toFixed(3)}, 1/4 beat ${(acc.t4 / Math.max(1, acc.tails)).toFixed(3)}, median error ${(acc.errs[acc.errs.length >> 1] ?? 0).toFixed(2)} beats`);
