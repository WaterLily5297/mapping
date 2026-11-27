import { describe, it, expect } from 'vitest';
import { analyze, estimateTempo, MAP_LEAD_MS } from '../src/automap/analysis';
import { autoMap } from '../src/automap/generate';
import { getKeys, parseOsu, writeOsu } from '../src/core/beatmap';
import { validate } from '../src/tools/transforms';

/** Synthetic song: kick on every beat, hi-hat on off-beats. */
function synth(bpm: number, offsetMs: number, seconds: number, sr = 22050): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sr));
  const beat = 60 / bpm;
  let rnd = 1;
  const noise = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let b = 0; offsetMs / 1000 + b * beat < seconds; b++) {
    const start = Math.floor((offsetMs / 1000 + b * beat) * sr);
    for (let i = 0; i < sr * 0.3 && start + i < out.length; i++) {
      const t = i / sr;
      out[start + i] += Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 25) * (b % 4 === 0 ? 0.9 : 0.6);
    }
    const hat = Math.floor((offsetMs / 1000 + (b + 0.5) * beat) * sr);
    for (let i = 0; i < sr * 0.04 && hat + i < out.length; i++) out[hat + i] += noise() * 0.3 * Math.exp(-i / sr * 80);
  }
  return out;
}

describe('auto-mapper', () => {
  const sr = 22050;
  const audio = synth(150, 230, 40, sr);

  it('detects BPM and offset of a click track', () => {
    const t = estimateTempo(analyze(audio, sr));
    // half/double tempo would also be "correct" musically, but we expect the exact one here
    expect(t.bpm).toBe(150);
    const beat = 400;
    // MAP_LEAD_MS: where a mapper places the note, before the detected attack
    const phaseErr = Math.abs((((t.offset - (230 - MAP_LEAD_MS)) % beat) + beat + beat / 2) % beat - beat / 2);
    expect(phaseErr).toBeLessThan(15);
  });

  for (const keys of [1, 4, 7, 10, 18]) {
    it(`generates a valid ${keys}K map`, () => {
      const { map } = autoMap(audio, sr, { keys, difficulty: 'insane', seed: 7 });
      expect(getKeys(map)).toBe(keys);
      expect(map.notes.length).toBeGreaterThan(40);
      expect(validate(map).filter((i) => i.severity === 'error')).toEqual([]);
      // every note on the 1/4 grid
      expect(validate(map).filter((i) => i.message.startsWith('Unsnapped'))).toEqual([]);
      expect(parseOsu(writeOsu(map)).notes).toEqual(map.notes);
      if (keys > 1) expect(new Set(map.notes.map((n) => n.column)).size).toBe(keys);
    });
  }

  it('respects difficulty density', () => {
    const easy = autoMap(audio, sr, { keys: 4, difficulty: 'easy', seed: 1 }).map.notes.length;
    const expert = autoMap(audio, sr, { keys: 4, difficulty: 'expert', seed: 1 }).map.notes.length;
    expect(expert).toBeGreaterThan(easy);
  });
});
