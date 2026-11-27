/**
 * Summarise compare-ai runs: for each run directory, score the AI outputs against the ranked
 * sections raw and after maniamap's star adjustment (what the app does by default).
 *
 *   npx tsx scripts/bench/summarize-ai.ts DATA_DIR KEYS RUN_DIR [RUN_DIR...]
 *
 * Each RUN_DIR is a compare-ai --out folder (results.json + <idx>-ai.osu). "bias" is the mean
 * signed raw star error (negative: the model maps easier than asked).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseOsu, getKeys, isLN, cloneBeatmap, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { starRating } from '../../src/analysis/difficulty';
import { classifyPatterns } from '../../src/analysis/patterns';
import { fitDifficulty } from '../../src/tools/difficultyfit';

const [dataDir, keysArg, ...runs] = process.argv.slice(2);
const keys = Number(keysArg);
const sets = readdirSync(dataDir).sort();
const cut = (m: Beatmap, a: number, b: number) => { const c = cloneBeatmap(m); c.notes = m.notes.filter((n) => n.time >= a && n.time < b).map((n) => ({ ...n })); return c; };
const rows = (m: Beatmap) => [...new Set(m.notes.map((n) => n.time))].sort((x, y) => x - y);
const f1 = (g: Beatmap, r: Beatmap) => { const a = rows(g), b = rows(r); let i = 0, j = 0, h = 0; while (i < a.length && j < b.length) { const d = a[i] - b[j]; if (Math.abs(d) <= 25) { h++; i++; j++; } else if (d < 0) i++; else j++; } const p = h / Math.max(1, a.length), q = h / Math.max(1, b.length); return p + q ? 2 * p * q / (p + q) : 0; };
const SK = ['Stream', 'Jumpstream', 'Handstream', 'Chordstream', 'Jackspeed', 'Chordjack', 'Technical', 'LN', 'Slow'];
const sk = (m: Beatmap) => { const g = classifyPatterns(m).byGroup as Record<string, number>; const v = SK.map((k) => g[k] ?? 0); const s = v.reduce((x, y) => x + y, 0) || 1; return v.map((x) => x / s); };
const tv = (a: number[], b: number[]) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / 2;

console.log(`${keys}K held-out sections; "fit" = after maniamap's star adjustment (the app default)`);
console.log('run                 songs  target  bias   starErr raw/fit   rhythmF1 raw/fit   skillTV raw/fit   s/song');
for (const run of runs) {
  if (!existsSync(join(run, 'results.json'))) { console.log(`${basename(run).padEnd(20)} (no results)`); continue; }
  const results = JSON.parse(readFileSync(join(run, 'results.json'), 'utf8')) as { song: string; ref?: string; target: number; aiSeconds: number }[];
  const acc = { t: 0, b: 0, n: 0, e: 0, fe: 0, f: 0, ff: 0, s: 0, fs: 0, secs: 0 };
  for (const [idx, set] of sets.entries()) {
    const res = results.find((r) => set.startsWith(r.song.slice(0, 30)));
    const aiFile = join(run, `${idx}-ai.osu`);
    if (!res || !existsSync(aiFile)) continue;
    const dir = join(dataDir, set);
    // the ranked difficulty compare-ai scored against (older runs: the one closest to 3.5 stars)
    const ref = res.ref ? parseOsu(readFileSync(join(dir, res.ref), 'utf8')) : readdirSync(dir).filter((f) => f.endsWith('.osu')).map((f) => parseOsu(readFileSync(join(dir, f), 'utf8')))
      .filter((m) => getKeys(m) === keys && redLines(m).length === 1 && m.notes.filter(isLN).length / m.notes.length < 0.2)
      .map((m) => ({ m, s: starRating(m).stars })).sort((a, b) => Math.abs(a.s - 3.5) - Math.abs(b.s - 3.5))[0]?.m;
    if (!ref) continue;
    const ai = parseOsu(readFileSync(aiFile, 'utf8'));
    if (!ai.notes.length) continue;
    const t0 = Math.min(...ai.notes.map((x) => x.time)) - 50, t1 = Math.max(...ai.notes.map((x) => x.time)) + 50;
    const refCut = cut(ref, t0, t1);
    const fitted = fitDifficulty(ai, res.target).map;
    acc.t += res.target; acc.b += starRating(ai).stars - res.target;
    acc.n++;
    acc.e += Math.abs(starRating(ai).stars - res.target); acc.fe += Math.abs(starRating(fitted).stars - res.target);
    acc.f += f1(ai, refCut); acc.ff += f1(fitted, refCut);
    acc.s += tv(sk(ai), sk(refCut)); acc.fs += tv(sk(fitted), sk(refCut));
    acc.secs += res.aiSeconds ?? 0;
  }
  const m = (k: keyof typeof acc) => (acc[k] / Math.max(1, acc.n));
  console.log(`${basename(run).padEnd(20)}${String(acc.n).padStart(5)}  ${m('t').toFixed(2).padStart(6)} ${m('b').toFixed(2).padStart(6)}    ${m('e').toFixed(2)} / ${m('fe').toFixed(2)}        ${m('f').toFixed(3)} / ${m('ff').toFixed(3)}      ${m('s').toFixed(3)} / ${m('fs').toFixed(3)}     ${m('secs').toFixed(0)}`);
}
