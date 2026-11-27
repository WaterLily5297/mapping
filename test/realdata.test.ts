import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseOsu, writeOsu, createBeatmap, makeNote } from '../src/core/beatmap';
import { classifyPatterns, type PatternType } from '../src/analysis/patterns';
import { rng } from '../src/core/rng';

describe('osu! developers\' labelled test chart (ppy/osu diffcalc-test.osu)', () => {
  const text = readFileSync(new URL('./fixtures/ppy-diffcalc-test.osu', import.meta.url), 'utf8');
  const map = parseOsu(text);
  const r = classifyPatterns(map);
  const at = (t: number): PatternType | undefined => r.sections.find((s) => s.start <= t && t <= r.rows[s.lastRow].time)?.type;

  it('parses every hit object and skips the // comments', () => {
    expect(map.notes.length).toBe(137);
    expect(parseOsu(writeOsu(map)).notes).toEqual(map.notes);
  });

  // [time inside the section, the file's own comment, accepted labels]
  const expected: [number, string, PatternType[]][] = [
    [5000, 'jacks spaced 1/2 beat apart', ['longjack', 'jack']],
    [7000, 'doubles jacks spaced 1/2 beat apart', ['chordjack', 'longjack']],
    [9500, 'trill spaced 1/2 beat apart', ['trill']],
    [11500, 'stair spaced 1/4 apart', ['roll']],
    [12500, 'stair spaced 1/4 apart', ['roll']],
    [14500, 'jumpstreams? (contains hands)', ['handstream', 'jumpstream']],
    [20000, 'notes overlapping hold', ['lncoordination']],
    [27500, 'quads', ['chordjack']],
    [30000, 'double-trills', ['jumptrill']],
  ];
  for (const [t, label, ok] of expected) {
    it(`${label} @ ${t}ms`, () => expect(ok).toContain(at(t)));
  }
});

describe('performance', () => {
  it('classifies a 40k-note 7K LN map in reasonable time', () => {
    const m = createBeatmap({ keys: 7, bpm: 200, offset: 0 });
    const rand = rng(3);
    for (let i = 0; i < 20000; i++) {
      const t = i * 75;
      const c1 = Math.floor(rand() * 7);
      m.notes.push(makeNote(t, c1, rand() < 0.5 ? t + 75 * (1 + Math.floor(rand() * 6)) : undefined));
      if (rand() < 0.8) m.notes.push(makeNote(t, (c1 + 3) % 7));
    }
    const t0 = performance.now();
    classifyPatterns(m);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(5000);
  });
});
