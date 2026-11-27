/**
 * Train the long-note model on ranked LN maps (25%+ long notes, one red line): which notes are
 * long (logistic regression) and where they end (conditional logit over tailCandidates()).
 * Split by beatmap set id (% 3 == 0 held out). Writes src/automap/lnmodel.ts.
 *
 *   npx tsx scripts/bench/train-ln-model.ts DATA_DIR [DATA_DIR...] [--cache f.json] [--dry]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, isLN, type Beatmap, type Note } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze } from '../../src/automap/analysis';
import { headFeatures, tailCandidates, tailGroupFeatures, lnContext, lnLayout, LN_HEAD_FEATURES, LN_TAIL_FEATURES } from '../../src/automap/longnotes';
import { rng } from '../../src/core/rng';

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--cache'));
const cache = opt('cache');

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

interface Data { heads: { id: number; x: number[]; y: number }[]; tails: { id: number; xs: number[][]; y: number }[] }
let data: Data = { heads: [], tails: [] };
if (cache && existsSync(cache)) data = JSON.parse(readFileSync(cache, 'utf8'));
else {
  const seen = new Set<number>();
  const rand = rng(11);
  let maps = 0;
  for (const dir of dirs) for (const set of readdirSync(dir).sort()) {
    const p = join(dir, set);
    if (!statSync(p).isDirectory()) continue;
    const id = Number(set.split(' ')[0]);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    const files = readdirSync(p), audio = files.find((f) => /^audio\./.test(f));
    if (!audio) continue;
    const lnMaps = files.filter((f) => f.endsWith('.osu')).map((f) => { try { return parseOsu(readFileSync(join(p, f), 'utf8')); } catch { return null; } })
      .filter((m): m is Beatmap => !!m && m.notes.length > 100 && redLines(m).length === 1 && m.notes.filter(isLN).length / m.notes.length >= 0.25);
    if (!lnMaps.length) continue;
    seen.add(id);
    const a = analyze(decode(join(p, audio)), 22050);
    const c = lnContext(a);
    for (const ref of lnMaps.slice(0, 3)) {
      maps++;
      const beat = redLines(ref)[0].beatLength;
      // features are computed on the short-note version, as at generation time
      const rice: Beatmap = { ...ref, notes: ref.notes.map((n) => ({ time: n.time, column: n.column })) };
      const L = lnLayout(rice.notes);
      const end = new Map(ref.notes.map((n) => [`${n.time}:${n.column}`, n.endTime]));
      const sample = (arr: Note[], k: number) => (arr.length <= k ? arr : arr.filter(() => rand() < k / arr.length));
      for (const n of sample(rice.notes, 700)) data.heads.push({ id, x: headFeatures(c, rice, L, n), y: end.get(`${n.time}:${n.column}`) !== undefined ? 1 : 0 });
      for (const n of sample(rice.notes.filter((n) => end.get(`${n.time}:${n.column}`) !== undefined), 150)) {
        const want = end.get(`${n.time}:${n.column}`)!;
        const cands = tailCandidates(rice, L, n);
        if (!cands.length) continue;
        let bi = 0;
        cands.forEach((e, i) => { if (Math.abs(e - want) < Math.abs(cands[bi] - want)) bi = i; });
        if (Math.abs(cands[bi] - want) > beat / 16 + 2) continue; // the ranked end is not a candidate (1/6, 1/12, free snap)
        data.tails.push({ id, xs: tailGroupFeatures(c, rice, L, n, cands), y: bi });
      }
    }
    process.stdout.write(`\r${seen.size} songs, ${maps} maps, ${data.heads.length} heads, ${data.tails.length} tails`);
  }
  console.log('');
  if (cache) writeFileSync(cache, JSON.stringify(data));
}

const test = (id: number) => id % 3 === 0;
const stats = (rows: number[][], names: string[]) => {
  const F = names.length;
  const mean = Array.from({ length: F }, (_, j) => rows.reduce((s, x) => s + x[j], 0) / rows.length);
  const std = Array.from({ length: F }, (_, j) => (names[j] === 'bias' ? 0 : Math.sqrt(rows.reduce((s, x) => s + (x[j] - mean[j]) ** 2, 0) / rows.length)));
  return { mean, std, z: (x: number[]) => x.map((v, j) => (std[j] > 0 ? (v - mean[j]) / std[j] : v)) };
};

// ---- heads: logistic regression
const Htr = data.heads.filter((h) => !test(h.id)), Hte = data.heads.filter((h) => test(h.id));
const hs = stats(Htr.map((h) => h.x), LN_HEAD_FEATURES);
const HZ = Htr.map((h) => hs.z(h.x));
const wh = new Array(LN_HEAD_FEATURES.length).fill(0);
for (let it = 0; it < 1500; it++) {
  const g = new Array(wh.length).fill(0);
  HZ.forEach((x, i) => { const p = 1 / (1 + Math.exp(-x.reduce((s, v, j) => s + v * wh[j], 0))); for (let j = 0; j < wh.length; j++) g[j] += (p - Htr[i].y) * x[j]; });
  for (let j = 0; j < wh.length; j++) wh[j] -= 0.3 * (g[j] / HZ.length + 0.001 * wh[j]);
}
// head quality: precision when taking the top share of notes (as placeLongNotes does), per song
const headEval = (set: typeof data.heads, score: (x: number[]) => number) => {
  const byId = new Map<number, { s: number; y: number }[]>();
  for (const h of set) { const l = byId.get(h.id) ?? []; l.push({ s: score(h.x), y: h.y }); byId.set(h.id, l); }
  let tp = 0, k = 0;
  for (const l of byId.values()) { const want = l.filter((v) => v.y).length; l.sort((x, y) => y.s - x.s); tp += l.slice(0, want).filter((v) => v.y).length; k += want; }
  return tp / Math.max(1, k);
};
const headScore = (x: number[]) => hs.z(x).reduce((s, v, j) => s + v * wh[j], 0);
// baseline: the old rule's idea (loudness stays up after the note), with room
const ruleScore = (x: number[]) => x[3] + 0.3 * x[7];

// ---- tails: conditional logit
const Ttr = data.tails.filter((t) => !test(t.id)), Tte = data.tails.filter((t) => test(t.id));
const ts = stats(Ttr.flatMap((t) => t.xs), LN_TAIL_FEATURES);
const TZ = Ttr.map((t) => t.xs.map(ts.z));
const wt = new Array(LN_TAIL_FEATURES.length).fill(0);
for (let it = 0; it < 600; it++) {
  const g = new Array(wt.length).fill(0);
  TZ.forEach((zs, i) => {
    const sc = zs.map((x) => x.reduce((s, v, j) => s + v * wt[j], 0)), m = Math.max(...sc), e = sc.map((v) => Math.exp(v - m)), sum = e.reduce((a, b) => a + b, 0);
    zs.forEach((x, k) => { const p = e[k] / sum - (k === Ttr[i].y ? 1 : 0); for (let j = 0; j < wt.length; j++) g[j] += p * x[j]; });
  });
  for (let j = 0; j < wt.length; j++) wt[j] -= 0.5 * (g[j] / TZ.length + 0.001 * wt[j]);
}
const tailEval = (set: typeof data.tails, score: (x: number[]) => number) => set.filter((t) => { let bi = 0, bs = -Infinity; t.xs.forEach((x, i) => { const s = score(x); if (s > bs) { bs = s; bi = i; } }); return bi === t.y; }).length / Math.max(1, set.length);
const tailScore = (x: number[]) => ts.z(x).reduce((s, v, j) => s + v * wt[j], 0);
// baseline: end where the next sound starts (onset strength), like a release on the next hit
const tailRule = (x: number[]) => x[5] - 0.01 * x[1];

console.log(`heads: ${Htr.length} train / ${Hte.length} held-out notes; precision at the ranked LN share: rule ${headEval(Hte, ruleScore).toFixed(3)}, model ${headEval(Hte, headScore).toFixed(3)} (train ${headEval(Htr, headScore).toFixed(3)})`);
console.log(`tails: ${Ttr.length} train / ${Tte.length} held-out long notes; exact end chosen: rule ${tailEval(Tte, tailRule).toFixed(3)}, model ${tailEval(Tte, tailScore).toFixed(3)} (train ${tailEval(Ttr, tailScore).toFixed(3)})`);
console.log('head weights:', LN_HEAD_FEATURES.map((n, j) => `${n} ${wh[j].toFixed(2)}`).join(', '));
console.log('tail weights:', LN_TAIL_FEATURES.map((n, j) => `${n} ${wt[j].toFixed(2)}`).join(', '));
if (!argv.includes('--dry')) {
  const note = `trained on ${Htr.length} notes / ${Ttr.length} long notes; held-out head precision ${headEval(Hte, headScore).toFixed(3)}, exact tail ${tailEval(Tte, tailScore).toFixed(3)}`;
  const r = (v: number[]) => v.map((x) => +x.toFixed(5));
  writeFileSync('src/automap/lnmodel.ts', `/** Learned long-note heads and tails; regenerated by scripts/bench/train-ln-model.ts. */
export interface LnPart { w: number[]; mean: number[]; std: number[] }
export interface LnModel { head: LnPart; tail: LnPart; note: string }
export const LN_MODEL: LnModel | null = ${JSON.stringify({ head: { w: r(wh), mean: r(hs.mean), std: r(hs.std) }, tail: { w: r(wt), mean: r(ts.mean), std: r(ts.std) }, note })};
`);
  console.log(`wrote src/automap/lnmodel.ts (${note})`);
}
