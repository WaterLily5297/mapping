/**
 * Builds examples/pattern-demo-4k.osu: one section of each common pattern, so you
 * can see what the classifier does (open it in the editor -> Patterns tab, or run
 * `maniamap patterns examples/pattern-demo-4k.osu`).
 *   npx tsx examples/make-demo.ts
 */
import { writeFileSync } from 'node:fs';
import { createBeatmap, makeNote, writeOsu, type Note } from '../src/core/beatmap';
import { rng } from '../src/core/rng';

const BPM = 170;
const Q = 60000 / BPM / 4;
const map = createBeatmap({ keys: 4, bpm: BPM, offset: 500, title: 'Pattern demo', artist: 'maniamap', version: '4K patterns' });
const rand = rng(7);
let t = 500;

function rows(list: number[][], step = Q) {
  for (const r of list) { for (const c of r) map.notes.push(makeNote(t, c)); t += step; }
  t += Q * 8; // short break between sections
}
const rep = <T>(p: T[], n: number) => Array.from({ length: n }, () => p).flat();
function noJack(n: number, sizes: number[]): number[][] {
  const out: number[][] = [];
  let prev: number[] = [], prev2 = '';
  for (let i = 0; i < n; i++) {
    let pick: number[] = [];
    for (let k = 0; k < 50; k++) {
      pick = [0, 1, 2, 3].filter((c) => !prev.includes(c)).sort(() => rand() - 0.5).slice(0, sizes[i % sizes.length]).sort();
      if (pick.join() !== prev2) break;
    }
    prev2 = prev.join(); prev = pick; out.push(pick);
  }
  return out;
}

rows(noJack(32, [1, 2]), Q * 4);                                   // slow
rows(noJack(48, [1]));                                             // stream
rows(noJack(48, [2, 1, 1, 2, 1]));                                 // jumpstream
rows(noJack(48, [3, 1, 2, 1]));                                    // handstream
rows(rep([[0], [0], [1], [1], [3], [3], [2], [2]], 6));            // jack
rows(rep([[0, 1, 2], [1, 2, 3], [0, 1, 3], [0, 2, 3]], 12));       // chordjack
rows(rep([[1], [2]], 24));                                         // trill
rows(rep([[0, 1], [2, 3]], 24));                                   // jumptrill
rows(rep([[0, 2], [1, 3]], 24));                                   // split trill
rows(rep([[0], [1], [2], [3], [2], [1]], 8).slice(0, 4).concat(rep([[0], [1], [2], [3]], 12))); // roll
// inverse: stream converted to LNs that release just before the next note in the column
const start = t;
const inv = noJack(48, [1, 2, 1]);
const notes: Note[] = [];
inv.forEach((r, i) => r.forEach((c) => notes.push(makeNote(start + i * Q, c))));
for (const n of notes) {
  const next = notes.find((m) => m.column === n.column && m.time > n.time);
  n.endTime = next ? next.time - Math.round(Q) : n.time + Q * 2;
  if (n.endTime - n.time < 30) n.endTime = undefined;
}
map.notes.push(...notes);
const out = new URL('./pattern-demo-4k.osu', import.meta.url).pathname;
writeFileSync(out, writeOsu(map));
console.log(`wrote ${out}`);
