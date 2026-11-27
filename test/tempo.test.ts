import { describe, it, expect } from 'vitest';
import { analyze, estimateTempo, MAP_LEAD_MS } from '../src/automap/analysis';

type Style = 'drums' | 'polymelody' | 'halftime';

/** Small synthetic songs with typical traps for tempo detection. */
function song(bpm: number, offset: number, style: Style, seconds = 30, sr = 22050): Float32Array {
  const out = new Float32Array(seconds * sr);
  const beat = 60 / bpm;
  let seed = Math.round(bpm * 13 + offset);
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (t: number, len: number, f: (x: number) => number) => {
    const s0 = Math.floor(t * sr);
    for (let i = 0; i < len * sr && s0 + i < out.length; i++) out[s0 + i] += f(i / sr);
  };
  const kick = (t: number) => add(t, 0.25, (x) => Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-x * 35)) * x) * Math.exp(-x * 14) * 0.9);
  const snare = (t: number) => add(t, 0.2, (x) => (rnd() * 0.6 + Math.sin(2 * Math.PI * 190 * x) * 0.4) * Math.exp(-x * 22) * 0.6);
  // hi-hat: high-passed noise (real hats have little energy below ~2 kHz)
  let h1 = 0, h2 = 0;
  const hp = () => { const v = rnd(); const d1 = v - h1; h1 = v; const d2 = d1 - h2; h2 = d1; return d2 / 4; };
  const hat = (t: number) => add(t, 0.05, (x) => hp() * Math.exp(-x * 90) * 0.5);
  const tone = (t: number, len: number, f: number, amp: number) =>
    add(t, len, (x) => Math.sin(2 * Math.PI * f * x) * amp * Math.min(1, x * 200) * Math.min(1, (len - x) * 30));
  const scale = [261.6, 293.7, 329.6, 392, 440, 523.3, 587.3, 659.3];
  for (let b = 0; offset / 1000 + b * beat < seconds; b++) {
    const t = offset / 1000 + b * beat;
    const inBar = b % 4;
    if (style === 'halftime') {
      if (inBar === 0) kick(t);
      if (inBar === 2) snare(t);
    } else {
      if (inBar === 0 || inBar === 2) kick(t);
      if (inBar === 1 || inBar === 3) snare(t);
    }
    hat(t + beat / 2);
    if (style === 'polymelody') {
      // a melody note on 3 of every 4 sixteenths, repeating every 3: the classic 2/3-tempo trap
      for (let q = 0; q < 4; q++) if ((b * 4 + q) % 3 !== 2) tone(t + (q * beat) / 4, beat / 4 * 0.9, scale[(b * 3 + q * 5) % 8], 0.25);
    }
    if (style === 'halftime') for (let q = 0; q < 4; q++) tone(t + (q * beat) / 4, beat / 4 * 0.9, scale[(b + q * 3) % 8], 0.2);
  }
  return out;
}

describe('tempo detection across tempos and styles', () => {
  const cases: [number, Style][] = [];
  for (const bpm of [100, 128, 140, 150, 160, 174, 180, 200, 222, 240]) cases.push([bpm, 'drums'], [bpm, 'polymelody']);
  for (const bpm of [128, 150, 174, 200]) cases.push([bpm, 'halftime']);
  for (const [bpm, style] of cases) {
    for (const offset of [50 + ((bpm * 7) % 400), 333]) {
      it(`${bpm} BPM, ${style}, offset ${offset}`, () => {
        const t = estimateTempo(analyze(song(bpm, offset, style), 22050));
        // half-time drums are genuinely ambiguous (the drums pulse at half the tempo):
        // accept the half-tempo octave there, never a non-octave error
        const ok = style === 'halftime' ? [bpm, bpm / 2] : [bpm];
        const err = Math.min(...ok.map((b) => Math.abs(t.bpm - b)));
        expect(err, `detected ${t.bpm}`).toBeLessThanOrEqual(0.5);
        const beat = 60000 / bpm;
        // a mapper places the note MAP_LEAD_MS before the detected attack (calibrated on ranked maps)
        const phaseErr = Math.abs((((t.offset - (offset - MAP_LEAD_MS)) % beat) + beat * 1.5) % beat - beat / 2);
        expect(phaseErr).toBeLessThan(20);
      });
    }
  }
});
