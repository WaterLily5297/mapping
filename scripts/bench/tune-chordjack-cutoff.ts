/**
 * Tune the speed-or-chordjack decision of auto style at high stars (target.ts CHORDJACK_CUTOFF):
 * for each song's hardest rice map of 6+ stars, the style model's song-wide chordjack probability
 * at that map's stars, against what the ranked map is (more time in jacks / chordjack, or in
 * streams / jumpstream / handstream). Finds the cutoff with the most agreement per key count on
 * training songs (set id % 3 != 0) and reports it on held-out songs (% 3 == 0), with the current
 * cutoff beside it.
 *
 *   npx tsx scripts/bench/tune-chordjack-cutoff.ts DATA_DIR [DATA_DIR...] [--keys 4,7] [--cache f.json]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOsu, getKeys, isLN, type Beatmap } from '../../src/core/beatmap';
import { redLines } from '../../src/core/timing';
import { analyze } from '../../src/automap/analysis';
import { starRating } from '../../src/analysis/difficulty';
import { classifyPatterns } from '../../src/analysis/patterns';
import { songStyleProbs } from '../../src/automap/generate';
import { STYLE_MODEL } from '../../src/automap/stylemodel';
import { CHORDJACK_CUTOFF } from '../../src/automap/target';

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const dirs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--keys', '--cache'].includes(argv[i - 1])));
const keysOk = (opt('keys') ?? '4,6,7').split(',').map(Number);
const cache = opt('cache');

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

interface Row { id: number; keys: number; stars: number; pJack: number; jackShare: number; speedShare: number }
let rows: Row[] = cache && existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) : [];
const done = new Set(rows.map((r) => `${r.id}:${r.keys}`));
const cj = STYLE_MODEL.classes.indexOf('chordjack');
let n = 0;
for (const dir of dirs) for (const set of readdirSync(dir).sort()) {
  const id = Number(set.split(' ')[0]);
  if (!Number.isFinite(id)) continue;
  const p = join(dir, set);
  let files: string[];
  try { if (!statSync(p).isDirectory()) continue; files = readdirSync(p); } catch { continue; }
  const audio = files.find((f) => /^audio\./.test(f));
  if (!audio) continue;
  const best = new Map<number, { m: Beatmap; s: number }>();
  for (const f of files.filter((x) => x.endsWith('.osu'))) {
    try {
      const m = parseOsu(readFileSync(join(p, f), 'utf8'));
      const k = getKeys(m);
      if (!keysOk.includes(k) || done.has(`${id}:${k}`) || redLines(m).length !== 1 || m.notes.filter(isLN).length / m.notes.length > 0.2) continue;
      const s = starRating(m).stars;
      if (s >= 6 && s > (best.get(k)?.s ?? 0)) best.set(k, { m, s });
    } catch { /* skip */ }
  }
  if (!best.size) continue;
  let a;
  try { a = analyze(decode(join(p, audio)), 22050); } catch { continue; }
  for (const [k, { m, s }] of best) {
    done.add(`${id}:${k}`);
    const red = redLines(m)[0];
    const pJack = songStyleProbs(a, k, s, 60000 / red.beatLength, red.time)[cj];
    const g = classifyPatterns(m).byGroup as Record<string, number>;
    const v = (x: string) => g[x] ?? 0;
    const tot = Object.values(g).reduce((x, y) => x + y, 0) || 1;
    rows.push({ id, keys: k, stars: +s.toFixed(2), pJack: +pJack.toFixed(4), jackShare: (v('Chordjack') + v('Jackspeed')) / tot, speedShare: (v('Stream') + v('Jumpstream') + v('Handstream')) / tot });
  }
  if (++n % 50 === 0) { console.log(`${rows.length} maps`); if (cache) writeFileSync(cache, JSON.stringify(rows)); }
}
if (cache) writeFileSync(cache, JSON.stringify(rows));

const isJack = (r: Row) => r.jackShare > r.speedShare;
const agree = (set: Row[], cut: number) => set.filter((r) => (r.pJack >= cut) === isJack(r)).length / Math.max(1, set.length);
console.log(`\n${rows.length} maps of 6+ stars`);
for (const k of keysOk) {
  const tr = rows.filter((r) => r.keys === k && r.id % 3 !== 0), te = rows.filter((r) => r.keys === k && r.id % 3 === 0);
  if (!tr.length) continue;
  let bestCut = CHORDJACK_CUTOFF, bestAcc = -1;
  for (let c = 0.05; c <= 0.95; c += 0.01) { const acc = agree(tr, c); if (acc > bestAcc + 1e-9) { bestAcc = acc; bestCut = +c.toFixed(2); } }
  console.log(`${k}K: ${tr.length} train / ${te.length} held-out maps, ${(100 * tr.filter(isJack).length / tr.length).toFixed(0)}% jack-heavy in training`);
  console.log(`   current cutoff ${CHORDJACK_CUTOFF}: train ${agree(tr, CHORDJACK_CUTOFF).toFixed(3)}, held-out ${agree(te, CHORDJACK_CUTOFF).toFixed(3)}`);
  console.log(`   best on train ${bestCut}:   train ${bestAcc.toFixed(3)}, held-out ${agree(te, bestCut).toFixed(3)}`);
}
