/**
 * Sound direction evidence: do ranked mappers place notes by stereo position (pan) or by pitch?
 *
 *   npx tsx scripts/bench/pan-evidence.ts DATA_DIR [--keys 7] [--songs 30]
 *
 * For every ranked map, each note row gets its lane position (mean column, 0 = left .. 1 = right),
 * the stereo position of the sound at that moment (pan of the onset: right minus left spectral flux
 * over their sum, -1 .. 1) and the pitch centroid maniamap uses today. Prints the per-song
 * correlation of lane position with pan and with pitch, and how wide the song's stereo image is.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, getKeys, type Beatmap } from '../../src/core/beatmap';
import { stereoPan, analyze } from '../../src/automap/analysis';

const argv = process.argv.slice(2);
const dataDir = argv[0];
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const keys = Number(opt('keys', '7')), nSongs = Number(opt('songs', '30'));

function decodeStereo(path: string): [Float32Array, Float32Array] {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '2', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  const all = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
  const n = all.length >> 1, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = all[2 * i]; R[i] = all[2 * i + 1]; }
  return [L, R];
}
function pearson(x: number[], y: number[]) {
  const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
const std = (x: number[]) => { const m = x.reduce((a, b) => a + b, 0) / x.length; return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length); };

const rowsOf = (m: Beatmap) => {
  const by = new Map<number, number[]>();
  for (const n of m.notes) { const r = by.get(n.time) ?? []; r.push(n.column); by.set(n.time, r); }
  return [...by.entries()].sort((a, b) => a[0] - b[0]);
};

const out: { song: string; rPan: number; rPitch: number; width: number }[] = [];
for (const set of readdirSync(dataDir).sort()) {
  if (out.length >= nSongs) break;
  const dir = join(dataDir, set);
  if (!statSync(dir).isDirectory()) continue;
  const files = readdirSync(dir);
  const audio = files.find((f) => /^audio\./.test(f));
  if (!audio) continue;
  const maps = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter((m): m is Beatmap => !!m && getKeys(m) === keys && m.notes.length > 200);
  if (!maps.length) continue;
  const [L, R] = decodeStereo(join(dir, audio));
  const pan = stereoPan(L, R, 22050);
  const mono = new Float32Array(L.length); for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) / 2;
  const a = analyze(mono, 22050);
  const at = (arr: Float32Array, t: number) => arr[Math.max(0, Math.min(arr.length - 1, Math.round((t / 1000) / a.frameDur - 0.72 * 1024 / a.hop)))] ?? 0;
  // one map per song: the one with the most notes (more rows, steadier correlations)
  const m = maps.sort((x, y) => y.notes.length - x.notes.length)[0];
  const rows = rowsOf(m).filter(([, cols]) => cols.length < keys); // full-width chords carry no direction
  const lane = rows.map(([, cols]) => cols.reduce((s, c) => s + c, 0) / cols.length / (keys - 1));
  const p = rows.map(([t]) => at(pan, t));
  const c = rows.map(([t]) => at(a.centroid, t));
  out.push({ song: set.slice(0, 40), rPan: pearson(lane, p), rPitch: pearson(lane, c), width: std(p) });
  const o = out[out.length - 1];
  console.log(`${o.song.padEnd(40)} lane~pan ${o.rPan.toFixed(3).padStart(6)}  lane~pitch ${o.rPitch.toFixed(3).padStart(6)}  stereo width ${o.width.toFixed(3)}`);
}
const mean = (k: 'rPan' | 'rPitch', f = (_: typeof out[0]) => true) => { const s = out.filter(f); return s.reduce((x, o) => x + o[k], 0) / Math.max(1, s.length); };
const wide = (o: typeof out[0]) => o.width >= 0.15;
console.log(`\n${out.length} songs (${keys}K): mean correlation lane~pan ${mean('rPan').toFixed(3)}, lane~pitch ${mean('rPitch').toFixed(3)}`);
console.log(`${out.filter(wide).length} songs with a wide stereo image (pan std >= 0.15): lane~pan ${mean('rPan', wide).toFixed(3)}, lane~pitch ${mean('rPitch', wide).toFixed(3)}`);
