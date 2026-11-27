/**
 * Head-to-head: maniamap's built-in generator vs Mapperatorinator (AI) on held-out songs.
 *
 *   npx tsx scripts/bench/compare-ai.ts DATA_DIR [--songs 8] [--keys 4] [--seconds 30] [--holdout 3] [--out DIR]
 *
 * For each held-out song with a ranked rice map, both generators get the same section (the
 * ranked map's busiest `--seconds`), key count, timing (the ranked map's red line) and star target
 * (the ranked map's stars on that section). Mapperatorinator runs without --fit (its raw output);
 * maniamap uses its default (auto style). Both are scored against the ranked section with the same
 * metrics as generator-bench. The AI needs `scripts/setup-mapperatorinator.sh`; on a CPU each song
 * takes a few minutes.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, writeOsu, getKeys, isLN, cloneBeatmap, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze } from '../../src/automap/analysis';
import { generateForStars } from '../../src/automap/target';
import { starRating } from '../../src/analysis/difficulty';
import { classifyPatterns } from '../../src/analysis/patterns';
import { dirt } from '../../src/tools/cleanliness';
import { fitDifficulty, rebirthToOfficial } from '../../src/tools/difficultyfit';
import { referenceMappers } from '../../src/ai/mappers';

const argv = process.argv.slice(2);
const dataDir = argv[0];
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const nSongs = Number(opt('songs', '8')), keysWanted = Number(opt('keys', '4')), seconds = Number(opt('seconds', '30'));
const holdout = Number(opt('holdout', '3'));
const outDir = resolve(opt('out', 'compare-ai-out'));
mkdirSync(outDir, { recursive: true });
const cli = resolve('dist/cli.mjs');
// --mapper auto: condition the AI on the best-fitting reference mapper, never the song's own mappers
const useMapper = opt('mapper', '') === 'auto';
// --lora NAME: use a fine-tuned LoRA (trained without the held-out songs: same --holdout rule)
const lora = opt('lora', '');
// --model mini: Mapperatorinator V32-mini instead of V32
const model = opt('model', '');
// --lookback X: Mapperatorinator's lookback fraction (default: whatever the CLI uses)
const lookback = opt('lookback', ''), lookahead = opt('lookahead', '');
// --seed N: sampling seed of the AI (default 7); several seeds measure how much quality varies
const seed = opt('seed', '7');

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}
const cut = (m: Beatmap, a: number, b: number) => { const c = cloneBeatmap(m); c.notes = m.notes.filter((n) => n.time >= a && n.time < b).map((n) => ({ ...n })); return c; };
const rowTimes = (m: Beatmap) => [...new Set(m.notes.map((n) => n.time))].sort((x, y) => x - y);
function f1(gen: Beatmap, ref: Beatmap) {
  const a = rowTimes(gen), b = rowTimes(ref);
  let i = 0, j = 0, hit = 0;
  while (i < a.length && j < b.length) { const d = a[i] - b[j]; if (Math.abs(d) <= 25) { hit++; i++; j++; } else if (d < 0) i++; else j++; }
  const p = hit / Math.max(1, a.length), r = hit / Math.max(1, b.length);
  return p + r ? (2 * p * r) / (p + r) : 0;
}
const SK = ['Stream', 'Jumpstream', 'Handstream', 'Chordstream', 'Jackspeed', 'Chordjack', 'Technical', 'LN', 'Slow'];
const skills = (m: Beatmap) => { const g = classifyPatterns(m).byGroup as Record<string, number>; const v = SK.map((k) => g[k] ?? 0); const s = v.reduce((x, y) => x + y, 0) || 1; return v.map((x) => x / s); };
const tv = (a: number[], b: number[]) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / 2;
const score = (gen: Beatmap, ref: Beatmap, target: number) => {
  const d = dirt(gen);
  return { stars: starRating(gen).stars, starErr: Math.abs(starRating(gen).stars - target), f1: f1(gen, ref), skillTV: tv(skills(gen), skills(ref)), dirt: d.score, fastJacks: d.fastJacks, notes: gen.notes.length };
};

function pickMapper(dir: string, keys: number, rebirthStars: number): number {
  let exclude: number[] = [];
  try { exclude = JSON.parse(readFileSync(join(dir, 'maniamap-source.json'), 'utf8')).beatmaps.map((b: { creator_id: number }) => b.creator_id); } catch { /* no metadata */ }
  const m = referenceMappers(keys, rebirthToOfficial(rebirthStars), exclude)[0];
  console.log(`   reference mapper: ${m ? `${m.name} (${m.id})` : 'none'}`);
  return m?.id ?? 0;
}

type Score = ReturnType<typeof score>;
const rows: { song: string; ref: string; target: number; mm: Score; ai: Score | null; aiSeconds: number }[] = [];
const sets = readdirSync(dataDir).sort();
for (const [idx, set] of sets.entries()) {
  if (rows.length >= nSongs) break;
  if (idx % holdout !== 0) continue;
  const dir = join(dataDir, set);
  const files = readdirSync(dir);
  const audio = files.find((f) => /^audio\./.test(f));
  if (!audio) continue;
  const cands = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return Object.assign(parseOsu(readFileSync(join(dir, f), 'utf8')), { file: f }); } catch { return null; } })
    .filter((m): m is Beatmap & { file: string } => !!m && getKeys(m) === keysWanted && redLines(m).length === 1 && m.notes.filter(isLN).length / Math.max(1, m.notes.length) < 0.2);
  if (!cands.length) continue;
  // --min-stars X: the song's hardest difficulty if it has X stars or more (high-difficulty test);
  // otherwise the difficulty closest to 3.5 stars
  const rated = cands.map((m) => ({ m, s: starRating(m).stars }));
  const minStars = Number(opt('min-stars', '0'));
  if (minStars > 0) { rated.sort((a, b) => b.s - a.s); if (rated[0].s < minStars) continue; } else rated.sort((a, b) => Math.abs(a.s - 3.5) - Math.abs(b.s - 3.5));
  const ref = rated[0].m;
  // busiest window of `seconds`
  const win = seconds * 1000;
  const times = ref.notes.map((n) => n.time).sort((a, b) => a - b);
  let bestStart = times[0], bestCount = 0;
  for (let i = 0, j = 0; i < times.length; i++) { while (times[j] < times[i] - win) j++; if (i - j + 1 > bestCount) { bestCount = i - j + 1; bestStart = times[i] - win; } }
  const start = Math.max(0, Math.round(bestStart)), end = start + win;
  const refCut = cut(ref, start, end);
  const target = starRating(refCut).stars;
  const red = redLines(ref)[0];

  // maniamap: whole song generated (it needs the context for the star search), then the same window
  const a = analyze(decode(join(dir, audio)), 22050);
  const mmFull = generateForStars(a, { keys: keysWanted, targetStars: target, bpm: 60000 / red.beatLength, offset: red.time, seed: 7, lnRatio: 0, style: 'auto' }).map;
  // aim at the section's target too (as the AI does), with maniamap's clean difficulty fit
  const mm = fitDifficulty(cut(mmFull, start, end), target, { seed: 7 }).map;

  // Mapperatorinator on the window, with the ranked timing
  const timingFile = join(outDir, `${idx}-timing.osu`);
  const t = cloneBeatmap(ref); t.notes = [];
  writeFileSync(timingFile, writeOsu(t));
  const aiOut = join(outDir, `${idx}-ai.osu`);
  let ai: Score | null = null;
  const t0 = Date.now();
  if (!existsSync(aiOut)) {
    const r = spawnSync('node', [cli, 'ai', join(dir, audio), '--keys', String(keysWanted), '--stars', target.toFixed(2), '--start', String(start), '--end', String(end),
      '--timing', timingFile,
      // without --mapper/--lora the CLI would apply its per-key defaults; a benchmark run states both
      '--mapper', useMapper ? String(pickMapper(dir, keysWanted, target)) : 'none',
      '--lora', lora || 'none',
      '--model', model || 'v32', ...(lookback ? ['--lookback', lookback] : []), ...(lookahead ? ['--lookahead', lookahead] : []), '--ln', '0', '--seed', seed, '--device', 'cpu', '-o', aiOut], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) console.log(`AI failed on ${set}: ${(r.stderr || r.stdout).split('\n').slice(-4).join(' ')}`);
  }
  const aiSeconds = (Date.now() - t0) / 1000;
  if (existsSync(aiOut)) ai = score(cut(parseOsu(readFileSync(aiOut, 'utf8')), start, end), refCut, target);
  const row = { song: set.slice(0, 40), ref: ref.file, target, mm: score(mm, refCut, target), ai, aiSeconds };
  rows.push(row);
  const fmt = (s: Score | null) => (s ? `${s.stars.toFixed(2)}* F1 ${s.f1.toFixed(2)} skillTV ${s.skillTV.toFixed(2)} dirt ${s.dirt.toFixed(0)} fastJ ${s.fastJacks.toFixed(0)}` : 'n/a');
  console.log(`${row.song}  target ${target.toFixed(2)}\n   maniamap ${fmt(row.mm)}\n   AI       ${fmt(row.ai)}  (${aiSeconds.toFixed(0)}s)`);
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(rows, null, 2));
}

const both = rows.filter((r) => r.ai);
const avg = (k: keyof Score, who: 'mm' | 'ai') => both.reduce((s, r) => s + (r[who]![k] as number), 0) / Math.max(1, both.length);
console.log(`\n${both.length} songs (${seconds}s sections, ${keysWanted}K)`);
console.log('              starErr   rhythmF1   skillTV   dirt   fastJacks');
for (const [name, who] of [['maniamap', 'mm'], ['Mapperatorinator', 'ai']] as const) {
  console.log(`${name.padEnd(16)}${avg('starErr', who).toFixed(3).padStart(7)}${avg('f1', who).toFixed(3).padStart(11)}${avg('skillTV', who).toFixed(3).padStart(10)}${avg('dirt', who).toFixed(1).padStart(7)}${avg('fastJacks', who).toFixed(1).padStart(12)}`);
}
