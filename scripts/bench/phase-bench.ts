/**
 * Beat phase (offset) against ranked maps, with the ranked BPM given (so tempo errors do not mix in).
 *
 *   npx tsx scripts/bench/phase-bench.ts DATA_DIR [DATA_DIR...] [--songs 80] [--train | --heldout]
 *
 * Variants:
 *   current   beatPhase(): best grid phase on 0.4 flux + low + 0.4 mid band envelope
 *   refined   current, then the grid is moved by the strength-weighted median distance of the
 *             detected onsets near its beats (within 1/8 beat)
 *   kick      half-beat choice by the low band only (kicks and snares are on beats, hats between)
 *   both      kick + refined
 * Errors are the distance of the detected grid to the ranked one, wrapped to +-half a beat:
 * within 5 / 10 / 25 ms, and how many are off by about half a beat or a quarter beat.
 * Split by beatmap set id (% 3 == 0 is held out), like the tempo model.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze, phaseOffset, PHASE_VARIANTS, type PhaseVariant } from '../../src/automap/analysis';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--songs'));
const nSongs = Number(opt('songs', '80'));
const split = argv.includes('--train') ? 'train' : argv.includes('--heldout') ? 'heldout' : '';

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

const errs: Record<PhaseVariant, { e: number; beat: number }[]> = Object.fromEntries(PHASE_VARIANTS.map((v) => [v, []])) as never;
const seen = new Set<number>();
outer: for (const dir of dirs) for (const set of readdirSync(dir).sort()) {
  if (seen.size >= nSongs) break outer;
  const p = join(dir, set);
  if (!statSync(p).isDirectory()) continue;
  const id = Number(set.split(' ')[0]);
  if (!Number.isFinite(id) || seen.has(id)) continue;
  if ((split === 'train' && id % 3 === 0) || (split === 'heldout' && id % 3 !== 0)) continue;
  const files = readdirSync(p), audio = files.find((f) => /^audio\./.test(f));
  if (!audio) continue;
  const maps = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(p, f), 'utf8')); } catch { return null; } }).filter((m): m is Beatmap => !!m && m.notes.length > 50);
  if (!maps.length || maps.some((m) => redLines(m).length !== 1)) continue;
  const red = redLines(maps[0])[0];
  if (maps.some((m) => Math.abs(redLines(m)[0].time - red.time) > 2 || Math.abs(redLines(m)[0].beatLength - red.beatLength) > 0.5)) continue;
  seen.add(id);
  const a = analyze(decode(join(p, audio)), 22050);
  const bpm = 60000 / red.beatLength;
  for (const v of PHASE_VARIANTS) {
    const { offsetMs } = phaseOffset(a, bpm, v);
    const beat = red.beatLength, d = (((offsetMs - red.time) % beat) + beat) % beat;
    errs[v].push({ e: d <= beat / 2 ? d : d - beat, beat });
  }
  process.stdout.write(`\r${seen.size} songs`);
}
console.log('');
for (const v of PHASE_VARIANTS) {
  const list = errs[v], n = list.length || 1;
  const within = (ms: number) => list.filter((x) => Math.abs(x.e) <= ms).length;
  const half = list.filter((x) => Math.abs(Math.abs(x.e) - x.beat / 2) <= x.beat / 8).length;
  const quarter = list.filter((x) => Math.abs(Math.abs(x.e) - x.beat / 4) <= x.beat / 16).length;
  const abs = list.map((x) => Math.abs(x.e)).sort((a, b) => a - b);
  console.log(`${v.padEnd(8)} ${list.length} songs: within 5 ms ${(100 * within(5) / n).toFixed(0)}%, 10 ms ${(100 * within(10) / n).toFixed(0)}%, 25 ms ${(100 * within(25) / n).toFixed(0)}%; half beat off ${half}, quarter beat off ${quarter}; median ${(abs[abs.length >> 1] ?? 0).toFixed(1)} ms`);
}
