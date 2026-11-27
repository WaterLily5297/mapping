/**
 * Whole-song timing against ranked maps, including songs with tempo changes: how many of the
 * ranked map's beats does the detected beat grid hit?
 *
 *   npx tsx scripts/bench/timing-bench.ts DATA_DIR [DATA_DIR...] [--songs 60] [--changes | --steady]
 *
 * Beats of the ranked timing (every red line, over the span of the notes) against beats of the
 * detected timing: precision / recall / F1 within 20 ms, and recall of ranked beats by a detected
 * beat or half beat (lenient: double or half tempo still lines up). Compares one constant BPM
 * (estimateTempo) with estimateTiming (tempo changes). --changes: only songs whose ranked map
 * changes BPM; --steady: only one-red-line songs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze, estimateTempo } from '../../src/automap/analysis';
import { estimateTiming, estimateTimingViterbi, _setTempoMapParams, _setSwitchPenalty, type RedLine } from '../../src/automap/tempomap';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--songs'));
const nSongs = Number(opt('songs', '60'));
// --gain G --shift MS: tempo-change parameters; --train-id / --heldout-id: set id % 3 != 0 / == 0
if (argv.includes('--gain')) _setTempoMapParams(Number(opt('gain', '0.06')), Number(opt('shift', '40')));
// --v2 [--penalty P]: the tempo-path version
if (argv.includes('--penalty')) _setSwitchPenalty(Number(opt('penalty', '0.25')));
const v2 = argv.includes('--v2');
const idSplit = argv.includes('--train-id') ? 'train' : argv.includes('--heldout-id') ? 'heldout' : '';
const mode = argv.includes('--changes') ? 'changes' : argv.includes('--steady') ? 'steady' : 'all';

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}
export function beatsOf(lines: RedLine[], t0: number, t1: number, sub = 1): number[] {
  const out: number[] = [];
  const ls = [...lines].sort((x, y) => x.time - y.time);
  ls.forEach((l, i) => {
    const end = i + 1 < ls.length ? ls[i + 1].time : t1 + 1;
    const step = l.beatLength / sub;
    // beats before the first red line continue its grid backwards
    let k = i === 0 ? Math.ceil((t0 - l.time) / step) : 0;
    for (let t = l.time + k * step; t < end; t = l.time + ++k * step) if (t >= t0 && t <= t1) out.push(t);
  });
  return out.sort((x, y) => x - y);
}
function matches(a: number[], b: number[], tol = 20) {
  let i = 0, j = 0, hit = 0;
  while (i < a.length && j < b.length) { const d = a[i] - b[j]; if (Math.abs(d) <= tol) { hit++; i++; j++; } else if (d < 0) i++; else j++; }
  return hit;
}

const acc: Record<'single' | 'changes', { p: number; r: number; lenient: number; n: number }> = { single: { p: 0, r: 0, lenient: 0, n: 0 }, changes: { p: 0, r: 0, lenient: 0, n: 0 } };
let split = 0;
const seen = new Set<number>();
outer: for (const dir of dirs) for (const set of readdirSync(dir).sort()) {
  if (seen.size >= nSongs) break outer;
  const p = join(dir, set);
  if (!statSync(p).isDirectory()) continue;
  const id = Number(set.split(' ')[0]);
  if (!Number.isFinite(id) || seen.has(id)) continue;
  if ((idSplit === 'train' && id % 3 === 0) || (idSplit === 'heldout' && id % 3 !== 0)) continue;
  const files = readdirSync(p), audio = files.find((f) => /^audio\./.test(f));
  if (!audio) continue;
  const maps = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(p, f), 'utf8')); } catch { return null; } }).filter((m): m is Beatmap => !!m && m.notes.length > 50);
  if (!maps.length) continue;
  const ref = maps.sort((x, y) => y.notes.length - x.notes.length)[0];
  const reds = redLines(ref);
  const changes = new Set(reds.map((r) => Math.round(60000 / r.beatLength))).size > 1;
  if ((mode === 'changes' && !changes) || (mode === 'steady' && reds.length !== 1)) continue;
  seen.add(id);
  const t0 = Math.min(...ref.notes.map((n) => n.time)), t1 = Math.max(...ref.notes.map((n) => n.time));
  const truth = beatsOf(reds.map((r) => ({ time: r.time, beatLength: r.beatLength })), t0, t1);
  const a = analyze(decode(join(p, audio)), 22050);
  const one = estimateTempo(a);
  const variants: Record<'single' | 'changes', RedLine[]> = { single: [{ time: one.offset, beatLength: 60000 / one.bpm }], changes: v2 ? estimateTimingViterbi(a) : estimateTiming(a) };
  if (variants.changes.length > 1) split++;
  for (const k of ['single', 'changes'] as const) {
    const det = beatsOf(variants[k], t0, t1), half = beatsOf(variants[k], t0, t1, 2), dbl = beatsOf(variants[k].map((l) => ({ ...l, beatLength: l.beatLength * 2 })), t0, t1);
    const h = matches(det, truth);
    acc[k].p += h / Math.max(1, det.length); acc[k].r += h / Math.max(1, truth.length);
    acc[k].lenient += Math.max(matches(half, truth), matches(det, truth), matches(dbl, truth) * 2 > truth.length ? matches(dbl, truth) : 0) / Math.max(1, truth.length);
    acc[k].n++;
  }
  
}
console.log('');
for (const k of ['single', 'changes'] as const) {
  const x = acc[k], P = x.p / Math.max(1, x.n), R = x.r / Math.max(1, x.n);
  console.log(`${k === 'single' ? 'one BPM      ' : 'tempo changes'} ${x.n} songs (${mode}, ${split} split): beats precision ${P.toFixed(3)} recall ${R.toFixed(3)} F1 ${(2 * P * R / Math.max(1e-9, P + R)).toFixed(3)}; ranked beats on a detected beat or half beat ${(x.lenient / Math.max(1, x.n)).toFixed(3)}`);
}
