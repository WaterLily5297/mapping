import { describe, it, expect } from 'vitest';
import { analyze, detectOnsets } from '../src/automap/analysis';
import { generateFromAnalysis, autoStyles, learnedRhythm, STYLES, type Style } from '../src/automap/generate';
import { gridTicksFor, gridDivisors, positionOf } from '../src/automap/rhythm';
import { STYLE_MODEL } from '../src/automap/stylemodel';
import { placeColumns, type PlannedRow } from '../src/automap/patternize';
import { classifyPatterns } from '../src/analysis/patterns';
import { dirt, validate } from '../src/tools/transforms';
import { getKeys, isLN } from '../src/core/beatmap';
import { rng } from '../src/core/rng';

/** synthetic song: kick on beats, snare on 2/4, 16th hats with accents */
function synth(bpm: number, seconds: number, sr = 22050): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sr));
  const beat = 60 / bpm;
  let rnd = 1;
  const noise = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let b = 0; b * beat < seconds; b++) {
    const s = Math.floor(b * beat * sr);
    for (let i = 0; i < sr * 0.3 && s + i < out.length; i++) {
      const t = i / sr;
      out[s + i] += Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 25) * 0.8;
      if (b % 2 === 1) out[s + i] += noise() * 0.4 * Math.exp(-t * 18);
    }
    for (const f of [0.25, 0.5, 0.75]) {
      const at = Math.floor((b + f) * beat * sr);
      for (let i = 0; i < sr * 0.05 && at + i < out.length; i++) out[at + i] += noise() * (f === 0.5 ? 0.35 : 0.2) * Math.exp(-i / sr * 70);
    }
    // sustained pad every 4 beats (for LNs)
    if (b % 4 === 0) for (let i = 0; i < sr * beat * 3 && s + i < out.length; i++) out[s + i] += Math.sin(2 * Math.PI * 330 * i / sr) * 0.15;
  }
  return out;
}

const a = analyze(synth(165, 45), 22050);
const styles = Object.keys(STYLES) as Style[];

describe('pattern styles', () => {
  for (const style of styles) {
    for (const keys of [4, 7]) {
      it(`${style} ${keys}K is valid and clean for its style`, () => {
        const m = generateFromAnalysis(a, { keys, style, difficulty: 'insane', seed: 5 });
        expect(getKeys(m)).toBe(keys);
        expect(m.notes.length).toBeGreaterThan(100);
        expect(validate(m).filter((i) => i.severity === 'error')).toEqual([]);
        if (style !== 'chordjack') expect(dirt(m).fastJacks, style).toBeLessThanOrEqual(1);
      });
    }
  }

  it('styles change the pattern mix the way their names say', () => {
    const group = (style: Style) => classifyPatterns(generateFromAnalysis(a, { keys: 4, style, difficulty: 'expert', seed: 5 })).byGroup;
    const cj = group('chordjack'), st = group('stream'), js = group('jumpstream');
    expect(cj.Chordjack ?? 0).toBeGreaterThan(st.Chordjack ?? 0);
    expect((st.Stream ?? 0)).toBeGreaterThan(cj.Stream ?? 0);
    expect((js.Jumpstream ?? 0) + (js.Handstream ?? 0)).toBeGreaterThan(st.Jumpstream ?? 0);
  });

  it('ln style makes long notes', () => {
    const m = generateFromAnalysis(a, { keys: 4, style: 'ln', difficulty: 'hard', seed: 5 });
    expect(m.notes.filter(isLN).length / m.notes.length).toBeGreaterThan(0.3);
    expect(dirt(m).tightReleases).toBe(0);
  });
});

describe('auto style (learned)', () => {
  it('generates valid, clean charts and adapts to the target stars', () => {
    for (const keys of [4, 7]) {
      const m = generateFromAnalysis(a, { keys, style: 'auto', difficulty: 'insane', targetStars: 4, seed: 5 });
      expect(m.notes.length).toBeGreaterThan(100);
      expect(validate(m).filter((i) => i.severity === 'error')).toEqual([]);
      expect(dirt(m).fastJacks).toBeLessThanOrEqual(1);
    }
  });

  it('picks styles per measure from the model, and jack bias leans towards chordjack', () => {
    const beat = 60000 / 165;
    const plain = autoStyles(a, 0, beat, 4, 5, 0, 45000);
    const biased = autoStyles(a, 0, beat, 4, 5, 1, 45000);
    expect(plain.length).toBeGreaterThan(20);
    const cj = (xs: typeof plain) => xs.filter((s) => s === STYLES.chordjack).length;
    expect(cj(biased)).toBeGreaterThanOrEqual(cj(plain));
    expect(cj(biased)).toBeGreaterThan(0);
  });

  it('the model has the rice styles and finite weights', () => {
    expect(STYLE_MODEL.classes).toEqual(['balanced', 'stream', 'jumpstream', 'chordjack']);
    expect(STYLE_MODEL.weights.flat().every(Number.isFinite)).toBe(true);
  });
});

describe('pattern engine', () => {
  const beatLen = 60000 / 180;
  const rows = (n: number, step: number, size = 1): PlannedRow[] =>
    Array.from({ length: n }, (_, i) => ({ t: 1000 + i * step, size, centroid: 0.5, beatFrac: ((i * step) / beatLen) % 1, beatIndex: Math.floor((i * step) / beatLen + 1e-6) }));

  it('a 1/4 single-note run never jacks faster than 1/2 beat on any key count', () => {
    for (const K of [2, 4, 5, 7, 10]) {
      const out = placeColumns(rows(256, beatLen / 4), { keys: K, beatLen, style: STYLES.stream, pitchFollow: 0.5, rand: rng(K) });
      const last = new Array(K).fill(-Infinity);
      out.forEach((cols, i) => {
        for (const c of cols) {
          expect(1000 + i * beatLen / 4 - last[c], `${K}K row ${i}`).toBeGreaterThanOrEqual(beatLen / 2 - 3.5);
          last[c] = 1000 + i * beatLen / 4;
        }
      });
    }
  });

  it('repeated rhythms often get repeated shapes', () => {
    const r = rows(128, beatLen / 4);
    const out = placeColumns(r, { keys: 4, beatLen, style: { ...STYLES.balanced, repeat: 1 }, pitchFollow: 0, rand: rng(3) });
    let same = 0;
    for (let b = 1; b < 32; b++) {
      const cur = out.slice(b * 4, b * 4 + 4).map((c) => c.join()).join('|');
      const pre = out.slice((b - 1) * 4, b * 4).map((c) => c.join()).join('|');
      const mir = out.slice((b - 1) * 4, b * 4).map((c) => c.map((x) => 3 - x).sort().join()).join('|');
      if (cur === pre || cur === mir) same++;
    }
    expect(same).toBeGreaterThan(10);
  });

  it('chords are split over both hands', () => {
    const out = placeColumns(rows(200, beatLen / 2, 2), { keys: 4, beatLen, style: STYLES.balanced, pitchFollow: 0.5, rand: rng(9) });
    const split = out.filter((c) => c.length === 2 && (c[0] < 2) !== (c[1] < 2)).length;
    expect(split / out.length).toBeGreaterThan(0.6);
  });
});

describe('imported timing (tempo changes)', () => {
  it('snaps every note to the grid of its own red line', () => {
    const red = (time: number, bpm: number) => ({ time, beatLength: 60000 / bpm, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 70, uninherited: true, effects: 0 });
    const timingPoints = [red(100, 165), red(20100, 220)];
    const m = generateFromAnalysis(a, { keys: 4, style: 'balanced', difficulty: 'insane', seed: 2, timingPoints });
    expect(m.timingPoints.filter((p) => p.uninherited).map((p) => p.time)).toEqual([100, 20100]);
    const late = m.notes.filter((n) => n.time > 20200);
    expect(late.length).toBeGreaterThan(20);
    for (const n of late) {
      const beats = ((n.time - 20100) / (60000 / 220)) * 4; // 1/4 grid of the second red line
      expect(Math.abs(beats - Math.round(beats)) * (60000 / 220 / 4), `note at ${n.time}`).toBeLessThan(2.5);
    }
  });
});

describe('learned rhythm', () => {
  it('lays grid ticks along every red line', () => {
    const m = generateFromAnalysis(a, { keys: 4, seed: 1, bpm: 120, offset: 0 });
    m.timingPoints = [
      { time: 0, beatLength: 500, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 70, uninherited: true, effects: 0 },
      { time: 2000, beatLength: 250, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 70, uninherited: true, effects: 0 },
    ];
    const ticks = gridTicksFor(m, 2, 0, 3000);
    expect(ticks.map((t) => t.t)).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2125, 2250, 2375, 2500, 2625, 2750, 2875]);
    expect(ticks[9]).toMatchObject({ beatIndex: 0, beatFrac: 0.5 });
  });

  it('uses a finer grid (1/8, 1/6) only for high targets and where the tempo allows', () => {
    expect(gridDivisors(60000 / 170, 4)).toEqual([4]);
    expect(gridDivisors(60000 / 170, 7)).toEqual([4, 6, 8]); // 1/6 = 59 ms, 1/8 = 44 ms
    expect(gridDivisors(60000 / 195, 7)).toEqual([4, 6]); // 1/6 = 51 ms, 1/8 would be 38 ms
    expect(gridDivisors(60000 / 230, 7)).toEqual([4]); // 1/6 would be 43 ms
    expect(gridDivisors(60000 / 284, 9)).toEqual([2]); // 1/4 would be 53 ms
    expect(positionOf(0.125)).toBe('eighth');
    expect(positionOf(1 / 6)).toBe('triplet');
    expect(positionOf(0.75)).toBe('quarter');
    const m = generateFromAnalysis(a, { keys: 4, seed: 1, bpm: 120, offset: 0 });
    const ticks = gridTicksFor(m, [4, 6], 0, 500);
    expect(ticks.map((t) => t.t)).toEqual([0, 83, 125, 167, 250, 333, 375, 417]);
  });

  it('keeps as many ticks as asked, preferring likely ones, in time order', () => {
    const map = generateFromAnalysis(a, { keys: 4, seed: 1, bpm: 165, offset: 0 });
    const onsets = detectOnsets(a, 0.5);
    const got = learnedRhythm(a, map, 4, onsets, 3.5, 150);
    expect(got.length).toBeGreaterThanOrEqual(150);
    expect(got.length).toBeLessThan(170);
    for (let i = 1; i < got.length; i++) expect(got[i].snapped).toBeGreaterThan(got[i - 1].snapped);
    // the synthetic song has its kicks on the beats: most chosen ticks are beats or half beats
    expect(got.filter((g) => g.beatFrac === 0 || g.beatFrac === 0.5).length / got.length).toBeGreaterThan(0.6);
  });

  it("the old onset-only rhythm is still available", () => {
    const m = generateFromAnalysis(a, { keys: 4, style: 'balanced', rhythm: 'onsets', difficulty: 'hard', seed: 3 });
    expect(m.notes.length).toBeGreaterThan(50);
  });
});
