import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createBeatmap, makeNote, parseOsu, type Beatmap } from '../src/core/beatmap';
import { starRating, crossWeights, crossWeightsRule } from '../src/analysis/difficulty';
import { fitDifficulty, rebirthToOfficial, officialToRebirth } from '../src/tools/difficultyfit';
import { generateForStars, generateBestOf } from '../src/automap/target';
import { chartQuality } from '../src/automap/quality';
import { aiBestOf, SEED_STEP } from '../src/ai/bestof';
import { writeOsu } from '../src/core/beatmap';
import { analyze } from '../src/automap/analysis';
import { dirt, validate } from '../src/tools/transforms';
import { rng } from '../src/core/rng';

/** jumpstream-ish chart without jacks, at a given BPM and 1/4 spacing */
function chart(keys: number, bpm: number, rows = 400, chords = [1, 2, 1, 1], seed = 1): Beatmap {
  const m = createBeatmap({ keys, bpm, offset: 0 });
  const q = 60000 / bpm / 4;
  const rand = rng(seed);
  let prev: number[] = [];
  for (let i = 0; i < rows; i++) {
    const free = [...Array(keys).keys()].filter((c) => !prev.includes(c)).sort(() => rand() - 0.5);
    const cols = free.slice(0, Math.max(1, Math.min(chords[i % chords.length], free.length)));
    for (const c of cols) m.notes.push(makeNote(1000 + Math.round(i * q), c));
    prev = cols;
  }
  return m;
}

describe('Star Rating Rebirth', () => {
  it('the general cross-column rule reproduces the paper table for 4K-10K', () => {
    for (let k = 4; k <= 10; k++) {
      const a = crossWeights(k), b = crossWeightsRule(k);
      expect(b).toHaveLength(a.length);
      b.forEach((v, i) => expect(v).toBeCloseTo(a[i], 6));
    }
  });

  it('rates every key count 1K-18K with a finite value', () => {
    for (let k = 1; k <= 18; k++) {
      const r = starRating(chart(k, 170, 200));
      expect(Number.isFinite(r.stars), `${k}K`).toBe(true);
      expect(r.stars).toBeGreaterThan(0);
      expect(r.curve.length).toBeGreaterThan(0);
    }
  });

  it('grows with speed, density and rate', () => {
    const slow = starRating(chart(4, 120)).stars;
    const fast = starRating(chart(4, 200)).stars;
    expect(fast).toBeGreaterThan(slow + 0.5);
    const sparse = starRating(chart(4, 170, 400, [1])).stars;
    const dense = starRating(chart(4, 170, 400, [2, 2, 1, 2])).stars;
    expect(dense).toBeGreaterThan(sparse);
    const m = chart(7, 160);
    expect(starRating(m, { rate: 1.3 }).stars).toBeGreaterThan(starRating(m).stars);
  });

  it('gives a sensible value for a real ranked map', () => {
    const m = parseOsu(readFileSync(new URL('./fixtures/ppy-diffcalc-test.osu', import.meta.url), 'utf8'));
    const s = starRating(m).stars;
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(15);
  });

  it('converts to and from the osu! scale', () => {
    for (const s of [1, 3.5, 6]) expect(officialToRebirth(rebirthToOfficial(s, 0.3), 0.3)).toBeCloseTo(s, 6);
  });
});

describe('difficulty fitting', () => {
  it('makes a chart easier to the target without adding dirt', () => {
    const src = chart(4, 190, 600, [2, 1, 2, 1]);
    const s0 = starRating(src).stars;
    const target = Math.round((s0 - 1.5) * 10) / 10;
    const r = fitDifficulty(src, target);
    expect(r.reached).toBe(true);
    expect(Math.abs(r.stars - target)).toBeLessThanOrEqual(0.1);
    expect(r.removed).toBeGreaterThan(0);
    expect(dirt(r.map).fastJacks).toBeLessThanOrEqual(dirt(src).fastJacks);
    expect(dirt(r.map).handImbalance).toBeLessThan(dirt(src).handImbalance + 0.1);
  });

  it('makes a sparse chart harder with clean notes', () => {
    const src = chart(7, 150, 200, [1]);
    // keep every other row (1/2 spacing) so there is room for more notes
    src.notes = src.notes.filter((_, i) => i % 2 === 0);
    const s0 = starRating(src).stars;
    const r = fitDifficulty(src, s0 + 0.8);
    expect(r.stars).toBeGreaterThan(s0 + 0.5);
    expect(r.added).toBeGreaterThan(0);
    expect(dirt(r.map).fastJacks).toBe(0);
    expect(validate(r.map).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('returns the map unchanged when it is already on target', () => {
    const src = chart(4, 170, 300);
    const r = fitDifficulty(src, starRating(src).stars);
    expect(r.added + r.removed).toBe(0);
  });
});

/** synthetic song: kick on beats, hat on off-beats, 16th shaker */
function synth(bpm: number, seconds: number, sr = 22050): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sr));
  const beat = 60 / bpm;
  let rnd = 1;
  const noise = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let b = 0; b * beat < seconds; b++) {
    const start = Math.floor(b * beat * sr);
    for (let i = 0; i < sr * 0.3 && start + i < out.length; i++) {
      const t = i / sr;
      out[start + i] += Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 25) * 0.8;
    }
    for (const f of [0.25, 0.5, 0.75]) {
      const at = Math.floor((b + f) * beat * sr);
      for (let i = 0; i < sr * 0.04 && at + i < out.length; i++) out[at + i] += noise() * (f === 0.5 ? 0.35 : 0.15) * Math.exp(-i / sr * 80);
    }
  }
  return out;
}

describe('generate for a target star rating', () => {
  const a = analyze(synth(170, 40), 22050);
  for (const [keys, target] of [[4, 1.5], [4, 3], [7, 2.5]] as const) {
    it(`${keys}K at ${target} stars`, () => {
      const r = generateForStars(a, { keys, targetStars: target, seed: 3 });
      expect(Math.abs(r.stars - target), `got ${r.stars}`).toBeLessThanOrEqual(0.15);
      expect(dirt(r.map).fastJacks).toBe(0);
      expect(validate(r.map).filter((i) => i.severity === 'error')).toEqual([]);
    });
  }

  it('harder targets give harder charts', () => {
    const lo = generateForStars(a, { keys: 4, targetStars: 1.5, seed: 3 }).stars;
    const hi = generateForStars(a, { keys: 4, targetStars: 3, seed: 3 }).stars;
    expect(hi).toBeGreaterThan(lo + 1);
  });

  it('best of several candidates scores at least as well as the first one', () => {
    const one = generateForStars(a, { keys: 7, targetStars: 2.5, seed: 3 });
    const best = generateBestOf(a, { keys: 7, targetStars: 2.5, seed: 3 }, 3);
    expect(best.candidates).toBe(3);
    expect(best.quality).toBeGreaterThanOrEqual(chartQuality(one.map, a, 2.5).total - 1e-9);
    expect(dirt(best.map).fastJacks).toBe(0);
  });

  it('AI best of N runs each seed once and keeps the best-scoring chart', async () => {
    // stand-in for the model: a Quick rules chart per seed, one deliberately off target
    const seeds: number[] = [];
    const start = (o: { seed?: number }) => {
      seeds.push(o.seed!);
      const stars = seeds.length === 2 ? 2.5 : 1.2;
      return { done: Promise.resolve({ osuText: writeOsu(generateForStars(a, { keys: 7, targetStars: stars, seed: o.seed }).map), log: [] }) };
    };
    const r = await aiBestOf(3, { audioPath: 'x', keys: 7, seed: 5 }, 2.5, { start, post: (t) => ({ map: parseOsu(t) }), analyze: () => a });
    expect(seeds).toEqual([5, 5 + SEED_STEP, 5 + 2 * SEED_STEP]);
    expect(r.scores).toHaveLength(3);
    expect(r.picked).toBe(r.scores.indexOf(Math.max(...r.scores)));
    expect(r.picked).toBe(1);
    // without an analysis there is nothing to score: one run
    seeds.length = 0;
    const one = await aiBestOf(3, { audioPath: 'x', keys: 7, seed: 5 }, 2.5, { start, post: (t) => ({ map: parseOsu(t) }), analyze: () => undefined });
    expect(seeds).toEqual([5]);
    expect(one.scores).toEqual([]);
  });
});

import { breakFastJacks } from '../src/tools/transforms';
describe('breaking fast jacks', () => {
  it('moves a stream jack to a free column and keeps every row time', () => {
    const m = createBeatmap({ keys: 7, bpm: 180, offset: 0 });
    const q = 60000 / 180 / 4;
    [0, 1, 1, 2, 3, 4, 5, 6].forEach((c, i) => m.notes.push(makeNote(Math.round(1000 + i * q), c)));
    const r = breakFastJacks(m, { maxRowSize: 2 });
    expect(r.moved).toBe(1);
    expect(dirt(r.map).fastJacks).toBe(0);
    expect(r.map.notes.map((n) => n.time)).toEqual(m.notes.map((n) => n.time));
  });
  it('leaves jacked chords alone', () => {
    const m = createBeatmap({ keys: 7, bpm: 180, offset: 0 });
    const q = 60000 / 180 / 4;
    for (const i of [0, 1]) for (const c of [0, 1, 2]) m.notes.push(makeNote(Math.round(1000 + i * q), c));
    expect(breakFastJacks(m, { maxRowSize: 2 }).moved).toBe(0);
  });
});
