/**
 * Does the quality score pick the better of several AI candidates? For held-out sections generated
 * with several seeds (compare-ai --seed, one --out folder per seed), measure each candidate against
 * the ranked map (rhythm F1, skill-mix distance, fast jacks) and compare: the candidate the score
 * picks, a random candidate (the average), and the best one (oracle).
 *
 *   npx tsx scripts/bench/seed-rerank.ts DATA_DIR KEYS RUN_DIR [RUN_DIR...] [--fit]
 *
 * --fit: measure each candidate after the star adjustment, as the app delivers it (the score is
 * still taken on the raw AI output, as in the app).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, cloneBeatmap, type Beatmap } from '../../src/core/beatmap';
import { analyze, detectOnsets } from '../../src/automap/analysis';
import { classifyPatterns } from '../../src/analysis/patterns';
import { dirt } from '../../src/tools/cleanliness';
import { chartQuality, type QualityParts } from '../../src/automap/quality';
import { fitDifficulty } from '../../src/tools/difficultyfit';

const args = process.argv.slice(2);
const withFit = args.includes('--fit');
const [dataDir, keysArg, ...runs] = args.filter((x) => x !== '--fit');
void keysArg;
const sets = readdirSync(dataDir).sort();
function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}
const cut = (m: Beatmap, a: number, b: number) => { const c = cloneBeatmap(m); c.notes = m.notes.filter((n) => n.time >= a && n.time < b).map((n) => ({ ...n })); return c; };
const rowsOf = (m: Beatmap) => [...new Set(m.notes.map((n) => n.time))].sort((x, y) => x - y);
const f1 = (g: Beatmap, r: Beatmap) => { const a = rowsOf(g), b = rowsOf(r); let i = 0, j = 0, h = 0; while (i < a.length && j < b.length) { const d = a[i] - b[j]; if (Math.abs(d) <= 25) { h++; i++; j++; } else if (d < 0) i++; else j++; } const p = h / Math.max(1, a.length), q = h / Math.max(1, b.length); return p + q ? 2 * p * q / (p + q) : 0; };
const SK = ['Stream', 'Jumpstream', 'Handstream', 'Chordstream', 'Jackspeed', 'Chordjack', 'Technical', 'LN', 'Slow'];
const sk = (m: Beatmap) => { const g = classifyPatterns(m).byGroup as Record<string, number>; const v = SK.map((k) => g[k] ?? 0); const s = v.reduce((x, y) => x + y, 0) || 1; return v.map((x) => x / s); };
const tv = (a: number[], b: number[]) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / 2;

interface Cand { run: string; f1: number; skill: number; fastJ: number; q: QualityParts; total: number }
const sections: Cand[][] = [];
const results = runs.map((r) => (existsSync(join(r, 'results.json')) ? JSON.parse(readFileSync(join(r, 'results.json'), 'utf8')) as { song: string; ref?: string; target: number }[] : []));
for (const [idx, set] of sets.entries()) {
  const res = results[0].find((r) => set.startsWith(r.song.slice(0, 30)));
  if (!res?.ref) continue;
  const files = runs.map((r) => join(r, `${idx}-ai.osu`));
  if (files.some((f) => !existsSync(f))) continue;
  const dir = join(dataDir, set);
  const ref = parseOsu(readFileSync(join(dir, res.ref), 'utf8'));
  // the busiest 30 s of the ranked map, as compare-ai picks it
  const win = 30000, times = ref.notes.map((n) => n.time).sort((a, b) => a - b);
  let bestStart = times[0], bestCount = 0;
  for (let i = 0, j = 0; i < times.length; i++) { while (times[j] < times[i] - win) j++; if (i - j + 1 > bestCount) { bestCount = i - j + 1; bestStart = times[i] - win; } }
  const start = Math.max(0, Math.round(bestStart)), end = start + win;
  const refCut = cut(ref, start, end);
  const audio = readdirSync(dir).find((f) => /^audio\./.test(f))!;
  const a = analyze(decode(join(dir, audio)), 22050);
  const onsets = detectOnsets(a, 0.6);
  const cands: Cand[] = files.map((f, i) => {
    const raw = cut(parseOsu(readFileSync(f, 'utf8')), start, end);
    const q = chartQuality(raw, a, res.target, { onsets, t0: start, t1: end });
    const m = withFit ? fitDifficulty(raw, res.target, { seed: 7 }).map : raw;
    return { run: basename(runs[i]), f1: f1(m, refCut), skill: tv(sk(m), sk(refCut)), fastJ: dirt(m).fastJacks, q: q.parts, total: q.total };
  });
  sections.push(cands);
  console.log(`${set.slice(0, 32).padEnd(32)} F1 ${cands.map((c) => c.f1.toFixed(2)).join(' ')} | skill ${cands.map((c) => c.skill.toFixed(2)).join(' ')} | score ${cands.map((c) => c.total.toFixed(2)).join(' ')}`);
}
const avg = (f: (c: Cand[]) => number) => sections.reduce((s, c) => s + f(c), 0) / Math.max(1, sections.length);
const mean = (c: Cand[], k: 'f1' | 'skill' | 'fastJ') => c.reduce((s, x) => s + x[k], 0) / c.length;
const pickBy = (score: (c: Cand) => number) => (c: Cand[]) => c.reduce((a, b) => (score(b) > score(a) ? b : a));
const report = (name: string, pick: (c: Cand[]) => Cand) => console.log(`${name.padEnd(22)} F1 ${avg((c) => pick(c).f1).toFixed(3)}  skill-mix distance ${avg((c) => pick(c).skill).toFixed(3)}  fast jacks ${avg((c) => pick(c).fastJ).toFixed(1)}`);
console.log(`\n${sections.length} sections x ${runs.length} candidates${withFit ? ' (measured after the star adjustment)' : ''}`);
console.log(`spread within a section: F1 ${avg((c) => Math.max(...c.map((x) => x.f1)) - Math.min(...c.map((x) => x.f1))).toFixed(3)}, skill-mix ${avg((c) => Math.max(...c.map((x) => x.skill)) - Math.min(...c.map((x) => x.skill))).toFixed(3)} (best - worst, mean)`);
console.log(`${'random (average)'.padEnd(22)} F1 ${avg((c) => mean(c, 'f1')).toFixed(3)}  skill-mix distance ${avg((c) => mean(c, 'skill')).toFixed(3)}  fast jacks ${avg((c) => mean(c, 'fastJ')).toFixed(1)}`);
report('score (all parts)', pickBy((c) => c.total));
for (const k of ['stars', 'onBeat', 'energy', 'filled', 'clean'] as (keyof QualityParts)[]) report(`score: ${k} only`, pickBy((c) => c.q[k]));
report('oracle (best F1)', pickBy((c) => c.f1));
report('oracle (best skill)', pickBy((c) => -c.skill));
