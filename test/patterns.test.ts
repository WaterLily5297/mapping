import { describe, it, expect } from 'vitest';
import { createBeatmap, makeNote, type Beatmap } from '../src/core/beatmap';
import { fullLN, inverseLN } from '../src/tools/transforms';
import { classifyPatterns, notesOfType, summarize, type PatternType } from '../src/analysis/patterns';
import { rng } from '../src/core/rng';

const BPM = 180;
const Q = 60000 / BPM / 4; // 1/4 note

/** rows of columns -> map, one row per 1/4 beat (or `step`) */
function build(keys: number, rows: number[][], opts: { step?: number; start?: number; map?: Beatmap } = {}): Beatmap {
  const map = opts.map ?? createBeatmap({ keys, bpm: BPM, offset: 0 });
  const step = opts.step ?? Q;
  let t = opts.start ?? 1000;
  for (const r of rows) {
    for (const c of r) map.notes.push(makeNote(t, c));
    t += step;
  }
  return map;
}

const repeat = <T>(pat: T[], times: number): T[] => Array.from({ length: times }, () => pat).flat();

/** random rows without jacks, with the given chord sizes */
function randomNoJack(keys: number, n: number, sizes: number[], seed = 1): number[][] {
  const rand = rng(seed);
  const rows: number[][] = [];
  let prev: number[] = [];
  let prev2: number[] = [];
  for (let i = 0; i < n; i++) {
    const size = sizes[i % sizes.length];
    let pick: number[] = [];
    for (let tries = 0; tries < 50; tries++) {
      const free = [...Array(keys).keys()].filter((c) => !prev.includes(c));
      free.sort(() => rand() - 0.5);
      pick = free.slice(0, size).sort((a, b) => a - b);
      // avoid accidental trills/rolls so the test is about chord sizes
      if (pick.join() !== prev2.join()) break;
    }
    rows.push(pick);
    prev2 = prev;
    prev = pick;
  }
  return rows;
}

function dominant(map: Beatmap): PatternType {
  return classifyPatterns(map).dominant[0];
}

describe('pattern classifier — single patterns', () => {
  const cases: [string, number, number[][], PatternType][] = [
    // 4K vocabulary (osu! wiki / Interlude)
    ['4K stream', 4, randomNoJack(4, 64, [1]), 'stream'],
    ['4K jumpstream', 4, randomNoJack(4, 64, [2, 1, 1, 2, 1]), 'jumpstream'],
    ['4K handstream', 4, randomNoJack(4, 64, [3, 1, 2, 1]), 'handstream'],
    ['4K quadstream (quads make minijacks with neighbours)', 4, repeat([[0, 1, 2, 3], [1], [0, 1, 2, 3], [2], [0, 3], [1]], 11), 'quadstream'],
    ['4K jacks (minijacks)', 4, repeat([[0], [0], [1], [1], [3], [3], [2], [2]], 8), 'jack'],
    ['4K longjack', 4, repeat([[0], [0], [0], [0], [2], [2], [2], [2]], 8), 'longjack'],
    ['4K chordjack', 4, repeat([[0, 1, 2], [1, 2, 3], [0, 1, 3], [0, 2, 3]], 16), 'chordjack'],
    ['4K trill', 4, repeat([[0], [1]], 32), 'trill'],
    ['4K minitrill', 4, repeat([[0], [1], [0], [1], [2], [3], [2], [3], [0], [3], [0], [3], [2], [1], [2], [1]], 5), 'minitrill'],
    ['4K jumptrill', 4, repeat([[0, 1], [2, 3]], 32), 'jumptrill'],
    ['4K split trill', 4, repeat([[0, 2], [1, 3]], 32), 'splittrill'],
    ['4K roll', 4, repeat([[0], [1], [2], [3]], 16), 'roll'],
    // 7K vocabulary (non-4K chordstreams)
    ['7K stream', 7, randomNoJack(7, 64, [1]), 'stream'],
    ['7K light chordstream', 7, randomNoJack(7, 64, [2, 1]), 'lightchordstream'],
    ['7K double stream', 7, randomNoJack(7, 64, [2]), 'doublestream'],
    ['7K dense chordstream', 7, randomNoJack(7, 64, [3, 1, 2, 2]), 'densechordstream'],
    ['7K dense chordstream with quads', 7, randomNoJack(7, 64, [4, 2, 4, 1]), 'densechordstream'],
    ['7K brackets (4+3 alternating)', 7, randomNoJack(7, 64, [4, 3]), 'brackets'],
    ['7K brackets [135][246]', 7, repeat([[0, 2, 4], [1, 3, 5]], 32), 'brackets'],
    ['7K chordjack', 7, repeat([[0, 2, 4, 6], [1, 2, 5], [0, 3, 5, 6], [1, 3, 4]], 16), 'chordjack'],
    ['7K roll', 7, repeat([[0], [1], [2], [3], [4], [5], [6]], 9), 'roll'],
    ['10K chord roll', 10, repeat([[0, 1], [2, 3], [4, 5], [6, 7], [8, 9]], 12), 'chordroll'],
    ['7K jumptrill (one hand each)', 7, repeat([[0, 1, 2], [4, 5, 6]], 32), 'jumptrill'],
    ['10K jumptrill', 10, repeat([[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]], 32), 'jumptrill'],
    ['1K is all jacks (longjack)', 1, repeat([[0]], 40), 'longjack'],
  ];
  for (const [name, keys, rows, want] of cases) {
    it(name, () => {
      const r = classifyPatterns(build(keys, rows));
      expect(r.dominant[0], summarize(r)).toBe(want);
      expect(r.byTime[want]!).toBeGreaterThan(0.7);
    });
  }

  it('slow quarter notes', () => {
    expect(dominant(build(4, randomNoJack(4, 32, [1, 2]), { step: Q * 4 }))).toBe('slow');
  });

  it('LN patterns: inverse, hold+tap, short LNs', () => {
    const stream = build(4, randomNoJack(4, 64, [1, 2, 1]));
    expect(dominant(inverseLN(stream))).toBe('inverse');
    // short LNs (1/4 beat) with clear gaps are not inverse; dense LN streams = "LN density" (osu! tag)
    expect(dominant(fullLN(stream, { maxBeats: 0.25, gapBeats: 0.25 }))).toBe('lndensity');
    // sparse LNs on half beats with long gaps: generic LN
    expect(dominant(fullLN(build(4, randomNoJack(4, 48, [1]), { step: Q * 2 }), { maxBeats: 0.5, gapBeats: 0.5 }))).toBe('ln');
    // column 0 holds long notes, columns 1..3 tap a stream
    const ht = createBeatmap({ keys: 4, bpm: BPM, offset: 0 });
    for (let i = 0; i < 8; i++) ht.notes.push(makeNote(1000 + i * Q * 8, 0, 1000 + i * Q * 8 + Q * 7));
    build(4, randomNoJack(3, 64, [1]).map((r) => r.map((c) => c + 1)), { map: ht, start: 1000 + Q });
    expect(dominant(ht)).toBe('lncoordination');
  });
});

describe('pattern classifier — mixed map', () => {
  // 32 rows each: stream -> jumptrill -> (break) -> chordjack -> roll
  const map = createBeatmap({ keys: 4, bpm: BPM, offset: 0 });
  build(4, randomNoJack(4, 32, [1], 3), { map, start: 1000 });
  build(4, repeat([[0, 1], [2, 3]], 16), { map, start: 1000 + 32 * Q });
  const afterBreak = 1000 + 64 * Q + 4000;
  build(4, repeat([[0, 1, 2], [1, 2, 3], [0, 1, 3], [0, 2, 3]], 8), { map, start: afterBreak });
  build(4, repeat([[3], [2], [1], [0]], 8), { map, start: afterBreak + 32 * Q });
  const r = classifyPatterns(map);

  it('finds the sections in order', () => {
    expect(r.sections.map((s) => s.type)).toEqual(['stream', 'jumptrill', 'chordjack', 'roll']);
  });
  it('sections line up with the boundaries (within 4 rows)', () => {
    const starts = r.sections.map((s) => s.start);
    const expected = [1000, 1000 + 32 * Q, afterBreak, afterBreak + 32 * Q];
    starts.forEach((s, i) => expect(Math.abs(s - expected[i])).toBeLessThanOrEqual(4 * Q + 1));
  });
  it('reports speed as 1/4 BPM', () => {
    expect(r.sections[0].speedBpm).toBe(BPM);
    expect(r.sections[0].speed).toBe('1/4 @ 180');
  });
  it('shares add up to 1 and notesOfType selects the right notes', () => {
    const sum = Object.values(r.byTime).reduce((a, b) => a + b!, 0);
    expect(sum).toBeCloseTo(1, 5);
    const jt = notesOfType(r, 'jumptrill');
    expect(jt.length).toBeGreaterThan(50);
    expect(jt.every((n) => n.time >= 1000 + 28 * Q && n.time < afterBreak)).toBe(true);
  });
  it('anchor detection', () => {
    // column 0 on every other note of a stream
    const m = build(4, Array.from({ length: 48 }, (_, i) => (i % 2 === 0 ? [0] : [1 + ((i >> 1) % 3)])));
    const s = classifyPatterns(m).sections;
    expect(s.some((x) => x.anchors.includes(0))).toBe(true);
  });
  it('empty map', () => {
    expect(classifyPatterns(createBeatmap({ keys: 7, bpm: 120 })).sections).toEqual([]);
  });
});

describe('pattern demo map (examples/pattern-demo-4k.osu)', () => {
  it('labels every demo section correctly', async () => {
    const { readFileSync } = await import('node:fs');
    const { parseOsu } = await import('../src/core/beatmap');
    const r = classifyPatterns(parseOsu(readFileSync(new URL('../examples/pattern-demo-4k.osu', import.meta.url), 'utf8')));
    expect(r.sections.filter((s) => s.rows >= 8).map((s) => s.type)).toEqual([
      'slow', 'stream', 'jumpstream', 'handstream', 'jack', 'chordjack',
      'trill', 'jumptrill', 'splittrill', 'roll', 'inverse',
    ]);
  });
});

describe('research-based details', () => {
  it('merges grace notes (flams) into chords', () => {
    // chordjack where every chord is split into two notes 10 ms apart
    const m = createBeatmap({ keys: 4, bpm: BPM, offset: 0 });
    for (let i = 0; i < 48; i++) {
      const t = 1000 + i * Q;
      const pair = i % 2 ? [1, 2] : [1, 3];
      m.notes.push(makeNote(t, pair[0]), makeNote(t + 10, pair[1]));
    }
    const r = classifyPatterns(m);
    expect(r.dominant[0]).toBe('chordjack');
    expect(r.sections[0].tags.graces).toBeGreaterThan(40);
  });

  it('does not merge a real fast burst', () => {
    const m = build(4, randomNoJack(4, 48, [1]), { step: 20 });
    expect(classifyPatterns(m).rows.length).toBe(48);
  });

  it('hand split: middle column of odd key counts is either hand', async () => {
    const { handOf, isOneHand } = await import('../src/analysis/patterns');
    expect([0, 1, 2, 3, 4, 5, 6].map((c) => handOf(c, 7))).toEqual([0, 0, 0, -1, 1, 1, 1]);
    expect(isOneHand([0, 1, 3], 7)).toBe(true);
    expect(isOneHand([1, 2], 4)).toBe(false);
  });

  it('shields, reverse shields and column lock', () => {
    const m = createBeatmap({ keys: 4, bpm: BPM, offset: 0 });
    for (let i = 0; i < 16; i++) {
      const t = 1000 + i * Q * 8;
      m.notes.push(makeNote(t, 0));                       // shield: note ...
      m.notes.push(makeNote(t + Q, 0, t + Q * 5));        // ... right before an LN head in column 1
      m.notes.push(makeNote(t + Q * 6, 0));               // reverse shield: note right after the release
      for (let k = 1; k <= 5; k++) m.notes.push(makeNote(t + Q * k + Q / 2, 1)); // column lock next to the hold
    }
    const tags = classifyPatterns(m).sections.map((s) => s.tags);
    const sum = (f: (t: (typeof tags)[number]) => number) => tags.reduce((a, t) => a + f(t), 0);
    expect(sum((t) => t.shields)).toBeGreaterThanOrEqual(15);
    expect(sum((t) => t.reverseShields)).toBeGreaterThanOrEqual(15);
    expect(sum((t) => t.columnLock)).toBeGreaterThanOrEqual(40);
  });

  it('LN release: staggered, varied releases', () => {
    const m = createBeatmap({ keys: 4, bpm: BPM, offset: 0 });
    const lens = [3, 5, 2, 7, 4, 6];
    for (let i = 0; i < 48; i++) {
      const t = 1000 + i * Q * 2;
      const len = lens[i % lens.length] * (Q / 2) + 7; // releases off the note grid
      m.notes.push(makeNote(t, i % 4, t + len));
    }
    expect(classifyPatterns(m).dominant[0]).toBe('lnrelease');
  });

  it('complex snap: 1/3 and 1/4 mixed', () => {
    const m = createBeatmap({ keys: 4, bpm: BPM, offset: 0 });
    let t = 1000;
    const rows = randomNoJack(4, 64, [1]);
    rows.forEach((r, i) => { m.notes.push(makeNote(t, r[0])); t += i % 8 < 4 ? Q : (Q * 4) / 3; });
    const r = classifyPatterns(m);
    expect(r.sections.some((s) => s.tags.complexSnap)).toBe(true);
  });

  it('map summary: category, slot and suggested osu! tags', () => {
    const js = build(4, randomNoJack(4, 600, [2, 1, 1, 2, 1, 2, 1]));
    const r = classifyPatterns(js);
    expect(r.category.startsWith('Jumpstream')).toBe(true);
    expect(r.slot).toBe('RC');
    expect(r.suggestedTags.map((t) => t.tag)).toContain('style/jumpstream');
    expect(r.suggestedTags.map((t) => t.tag)).not.toContain('style/chordjack');

    const cs7 = classifyPatterns(build(7, randomNoJack(7, 600, [2, 1, 3, 1, 2])));
    const tags7 = cs7.suggestedTags.map((t) => t.tag);
    expect(tags7).toContain('style/chordstream');
    expect(tags7.filter((t) => /jumpstream|handstream|quadstream/.test(t))).toEqual([]);

    const inv = inverseLN(build(4, randomNoJack(4, 300, [1, 2, 1])));
    const ri = classifyPatterns(inv);
    expect(ri.slot).toBe('LN');
    expect(ri.suggestedTags.map((t) => t.tag)).toContain('gimmick/LN inverse');
  });
});
