/**
 * Audio analysis against ranked maps: is the detected beat grid the ranked map's, and are the
 * detected onsets the sounds mappers put notes on?
 *
 *   npx tsx scripts/bench/audio-bench.ts DATA_DIR [DATA_DIR...] [--songs 60] [--keys 4,7]
 *
 * Songs whose ranked maps have one red line. Tempo: the detected BPM against the ranked one
 * (exact within 0.5%, or an octave / 3:2 error), and for exact BPMs the offset error (distance of
 * the detected beat grid to the ranked one, in ms, wrapped to half a beat). Onsets: the "mapped
 * sounds" are the rows of all the song's ranked difficulties (union); onsets are scored at the
 * sensitivity whose count is closest to that, as precision / recall / F1 (within 25 ms), and also
 * as recall of the hardest difficulty's rows that sit on a 1/1 or 1/2 beat (the strong sounds).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, getKeys, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze, detectOnsets, estimateTempo, _setOnsetInterp, estimateTempoHeuristic, beatPhase, ONSET_LATENCY, MAP_LEAD_MS, type Analysis } from '../../src/automap/analysis';
import { starRating } from '../../src/analysis/difficulty';

const argv = process.argv.slice(2);
const dirs = argv.filter((x, i) => !x.startsWith('--') && !(i > 0 && ['--songs', '--keys', '--interp'].includes(argv[i - 1])));
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
// --train / --heldout: only songs with index % 3 != 0 / == 0 in each folder (calibrate on one, check on the other)
const split = argv.includes('--train') ? 'train' : argv.includes('--heldout') ? 'heldout' : '';
// --interp on|off: sub-frame onset interpolation
if (argv.includes('--interp')) _setOnsetInterp(opt('interp', 'on') === 'on');
const nSongs = Number(opt('songs', '60')), keysOk = opt('keys', '4,7').split(',').map(Number);

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}
export function matchCount(a: number[], b: number[], tol = 25): number {
  let i = 0, j = 0, hit = 0;
  while (i < a.length && j < b.length) { const d = a[i] - b[j]; if (Math.abs(d) <= tol) { hit++; i++; j++; } else if (d < 0) i++; else j++; }
  return hit;
}
/** onsets at the sensitivity whose count is closest to `want` */
export function onsetsNear(a: Analysis, want: number): number[] {
  let lo = 0, hi = 1, best: number[] = [];
  for (let k = 0; k < 14; k++) {
    const s = (lo + hi) / 2;
    const o = detectOnsets(a, s).map((x) => x.time);
    if (!best.length || Math.abs(o.length - want) < Math.abs(best.length - want)) best = o;
    if (o.length < want) lo = s; else hi = s;
  }
  return best;
}

const songs: { set: string; bpmRef: number; bpmGot: number; kind: string; offErr: number; offSigned: number; onsetBias: number; timingErr: number; codec: string; p: number; r: number; strongR: number }[] = [];
outer: for (const dataDir of dirs) {
  for (const [idx, set] of readdirSync(dataDir).sort().entries()) {
    if (songs.length >= nSongs) break outer;
    const sid = Number(set.split(' ')[0]);
    if ((split === 'train' && idx % 3 === 0) || (split === 'heldout' && idx % 3 !== 0)) continue;
    // --heldout-id: songs the tempo and phase models never saw (beatmap set id % 3 == 0)
    if (argv.includes('--heldout-id') && !(sid % 3 === 0)) continue;
    const dir = join(dataDir, set);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir);
    const audio = files.find((f) => /^audio\./.test(f));
    if (!audio) continue;
    const maps = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
      .filter((m): m is Beatmap => !!m && keysOk.includes(getKeys(m)) && redLines(m).length === 1 && m.notes.length > 100);
    if (!maps.length) continue;
    const red = redLines(maps[0])[0];
    if (maps.some((m) => Math.abs(redLines(m)[0].beatLength - red.beatLength) > 0.5)) continue;
    const a = analyze(decode(join(dir, audio)), 22050);
    // tempo
    // --baseline: maniamap before this work (heuristic tempo, plain beat phase, no mapping lead)
    const t = argv.includes('--baseline')
      ? (() => { const h = estimateTempoHeuristic(a); return { ...h, offset: Math.round((beatPhase(a, h.bpm) * a.frameDur + ONSET_LATENCY(a)) * 1000 + MAP_LEAD_MS) }; })()
      : estimateTempo(a);
    const bpmRef = 60000 / red.beatLength, ratio = t.bpm / bpmRef;
    const near = (x: number) => Math.abs(ratio / x - 1) < 0.005;
    const kind = near(1) ? 'exact' : near(2) || near(0.5) ? 'octave' : near(1.5) || near(2 / 3) || near(3) || near(1 / 3) ? 'triple' : 'other';
    let offErr = NaN, offSigned = NaN;
    if (kind === 'exact') {
      const beat = red.beatLength, d = (((t.offset - red.time) % beat) + beat) % beat;
      offErr = Math.min(d, beat - d);
      offSigned = d <= beat / 2 ? d : d - beat; // + = detected grid later than the ranked one
    }
    // onsets
    const rows = [...new Set(maps.flatMap((m) => m.notes.map((n) => n.time)))].sort((x, y) => x - y);
    const t0 = rows[0] - 200, t1 = rows[rows.length - 1] + 200;
    const inSpan = (x: number) => x >= t0 && x <= t1;
    const hard = maps.map((m) => ({ m, s: starRating(m).stars })).sort((x, y) => y.s - x.s)[0].m;
    const strong = [...new Set(hard.notes.map((n) => n.time))].filter((x) => { const b = (x - red.time) / red.beatLength * 2; return Math.abs(b - Math.round(b)) * red.beatLength / 2 < 3; }).sort((x, y) => x - y);
    const on = onsetsNear(a, rows.length).filter(inSpan);
    const hit = matchCount(on, rows), sh = matchCount(on, strong);
    // timing bias of the onsets: median signed distance to the nearest mapped row (within 60 ms)
    const ds: number[] = [];
    for (const x of on) { let lo = 0, hi = rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m] < x) lo = m + 1; else hi = m; }
      const c = [rows[lo - 1], rows[lo]].filter((y) => y !== undefined).sort((u, v) => Math.abs(u - x) - Math.abs(v - x))[0]; if (c !== undefined && Math.abs(x - c) <= 60) ds.push(x - c); }
    ds.sort((x, y) => x - y);
    const onsetBias = ds[Math.floor(ds.length / 2)] ?? NaN;
    // timing precision: absolute error of onsets within 25 ms of a mapped row, after this song's bias
    const absErr = ds.filter((d) => Math.abs(d) <= 25).map((d) => Math.abs(d - onsetBias)).sort((x, y) => x - y);
    const timingErr = absErr[Math.floor(absErr.length / 2)] ?? NaN;
    songs.push({ set, bpmRef, bpmGot: t.bpm, kind, offErr, offSigned, onsetBias, timingErr, codec: audio.split('.').pop()!, p: hit / Math.max(1, on.length), r: hit / Math.max(1, rows.length), strongR: sh / Math.max(1, strong.length) });
    const s = songs[songs.length - 1];
    console.log(`${set.slice(0, 34).padEnd(34)} bpm ${s.bpmRef.toFixed(1).padStart(6)} got ${s.bpmGot.toFixed(1).padStart(6)} ${s.kind.padEnd(6)} ${Number.isNaN(offSigned) ? '         ' : `off ${offSigned.toFixed(0).padStart(4)}ms`} onset bias ${onsetBias.toFixed(0).padStart(4)}ms  onsets P ${s.p.toFixed(2)} R ${s.r.toFixed(2)} strongR ${s.strongR.toFixed(2)}`);
  }
}
const n = songs.length, cnt = (k: string) => songs.filter((s) => s.kind === k).length;
const ex = songs.filter((s) => s.kind === 'exact');
const off = ex.map((s) => s.offErr).sort((x, y) => x - y);
const mean = (f: (s: typeof songs[0]) => number) => songs.reduce((x, s) => x + f(s), 0) / Math.max(1, n);
console.log(`\n${n} songs: BPM exact ${cnt('exact')} (${(100 * cnt('exact') / n).toFixed(0)}%), octave ${cnt('octave')}, 3:2 ${cnt('triple')}, other ${cnt('other')}`);
console.log(`offset error (exact BPM): median ${(off[Math.floor(off.length / 2)] ?? NaN).toFixed(0)} ms, within 10 ms ${ex.filter((s) => s.offErr <= 10).length}/${ex.length}, within 25 ms ${ex.filter((s) => s.offErr <= 25).length}/${ex.length}`);
const med = (v: number[]) => { const w = v.filter((x) => !Number.isNaN(x)).sort((x, y) => x - y); return w[Math.floor(w.length / 2)] ?? NaN; };
for (const codec of [...new Set(songs.map((s) => s.codec))]) {
  const c = songs.filter((s) => s.codec === codec);
  console.log(`${codec}: ${c.length} songs, median signed offset ${med(c.map((s) => s.offSigned)).toFixed(1)} ms (+ = detected later), median onset bias ${med(c.map((s) => s.onsetBias)).toFixed(1)} ms`);
}
const P = mean((s) => s.p), R = mean((s) => s.r);
console.log(`onset timing error (median, after each song's bias): ${med(songs.map((s) => s.timingErr)).toFixed(2)} ms`);
console.log(`onsets vs mapped rows: precision ${P.toFixed(3)} recall ${R.toFixed(3)} F1 ${(2 * P * R / (P + R)).toFixed(3)}; strong-beat rows found ${mean((s) => s.strongR).toFixed(3)}`);
