import { describe, it, expect } from 'vitest';
import { analyze, analyzeStereo, stereoWidth, STEREO_WIDTH_AUTO } from '../src/automap/analysis';
import { generateFromAnalysis, resolveDirection, loudnessEnvelope, defaultContrast } from '../src/automap/generate';

const SR = 22050, BPM = 120, BEAT = 60 / BPM;

/** clicks on every half beat; measures alternate between the left and the right speaker */
function pannedTrack(seconds: number): { L: Float32Array; R: Float32Array } {
  const n = Math.floor(seconds * SR), L = new Float32Array(n), R = new Float32Array(n);
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let t = 0.5; t < seconds - 0.2; t += BEAT / 2) {
    const right = Math.floor((t - 0.5) / (BEAT * 4)) % 2 === 1;
    const s0 = Math.floor(t * SR);
    for (let i = 0; i < 0.04 * SR; i++) {
      const v = noise() * Math.exp(-i / (0.008 * SR)) * 0.8;
      if (right) R[s0 + i] += v; else L[s0 + i] += v;
    }
  }
  return { L, R };
}

const meanLane = (cols: number[]) => cols.reduce((s, c) => s + c, 0) / Math.max(1, cols.length);

describe('sound direction (stereo position -> lanes)', () => {
  const { L, R } = pannedTrack(34);
  const a = analyzeStereo(L, R, SR);
  const opts = { keys: 7, bpm: BPM, offset: 500, difficulty: 'hard' as const, style: 'balanced' as const, seed: 3, lnRatio: 0 };
  const split = (m: ReturnType<typeof generateFromAnalysis>) => {
    const left: number[] = [], right: number[] = [];
    for (const n of m.notes) (Math.floor((n.time - 500) / (BEAT * 4000)) % 2 === 1 ? right : left).push(n.column);
    return { left: meanLane(left), right: meanLane(right) };
  };

  it('measures a clearly panned mix as wide and a mono mix as zero', () => {
    expect(stereoWidth(a)).toBeGreaterThanOrEqual(STEREO_WIDTH_AUTO);
    expect(stereoWidth(analyzeStereo(L, L, SR))).toBeLessThan(0.01);
    expect(resolveDirection(a, 'auto')).toBe('stereo');
    expect(resolveDirection(analyze(L, SR), 'auto')).toBe('pitch'); // no stereo information
  });

  it('puts left-speaker measures on the left lanes and right-speaker measures on the right', () => {
    const s = split(generateFromAnalysis(a, { ...opts, direction: 'stereo' }));
    expect(s.right - s.left).toBeGreaterThan(1.5);
  });

  it('pitch direction ignores the stereo position', () => {
    const s = split(generateFromAnalysis(a, { ...opts, direction: 'pitch' }));
    expect(Math.abs(s.right - s.left)).toBeLessThan(0.8);
  });
});

describe('loudness envelope (contrast)', () => {
  it('is a z-score: louder windows are positive, quieter negative', () => {
    const n = 20 * SR, x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.05) * (i < n / 2 ? 0.05 : 0.8);
    const a = analyze(x, SR);
    const env = loudnessEnvelope(a, 2000);
    const q = Math.floor(env.length / 4);
    expect(env[q]).toBeLessThan(-0.5);
    expect(env[3 * q]).toBeGreaterThan(0.5);
  });
});

describe('default contrast', () => {
  it('is off for easy targets and reaches the tuned 1.5 from 6 stars', () => {
    expect(defaultContrast(2)).toBe(0);
    expect(defaultContrast(3)).toBe(0);
    expect(defaultContrast(4.5)).toBeCloseTo(0.75);
    expect(defaultContrast(6)).toBeCloseTo(1.5);
    expect(defaultContrast(10)).toBeCloseTo(1.5);
  });
});

describe('contrast-aware star adjustment', () => {
  it('removes notes from the quiet half first when it knows the loudness', async () => {
    const { createBeatmap, makeNote } = await import('../src/core/beatmap');
    const { fitDifficulty } = await import('../src/tools/difficultyfit');
    const m = createBeatmap({ keys: 7, bpm: 180, offset: 0 });
    const beat = 60000 / 180;
    // a steady 1/4 stream for 64 beats; the song is quiet in the first half and loud in the second
    for (let i = 0; i < 256; i++) m.notes.push(makeNote(i * beat / 4, (i * 3) % 7));
    const half = 32 * beat;
    const loudness = (t: number) => (t < half ? -1 : 1);
    const { starRating } = await import('../src/analysis/difficulty');
    const target = starRating(m).stars * 0.6;
    const plain = fitDifficulty(m, target, { seed: 2 });
    const aware = fitDifficulty(m, target, { seed: 2, loudness });
    const share = (x: typeof m) => x.notes.filter((n) => n.time >= half).length / x.notes.length;
    expect(aware.removed).toBeGreaterThan(0);
    expect(share(aware.map)).toBeGreaterThan(share(plain.map) + 0.05);
    expect(share(aware.map)).toBeGreaterThan(0.55);
  });
});

describe('contrast source per key count', () => {
  it('uses the music-energy curve from 6K and loudness below', async () => {
    const { contrastSourceFor } = await import('../src/automap/generate');
    expect(contrastSourceFor(4)).toBe('loudness');
    expect(contrastSourceFor(6)).toBe('energy');
    expect(contrastSourceFor(7)).toBe('energy');
  });
});
