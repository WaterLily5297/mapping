import { describe, it, expect } from 'vitest';
import { analyze } from '../src/automap/analysis';
import { estimateTiming } from '../src/automap/tempomap';

const SR = 22050;
/** kick on beats, hat between; tempo `bpm1` until `change` seconds, then `bpm2` */
function track(seconds: number, bpm1: number, bpm2: number, change: number): Float32Array {
  const out = new Float32Array(seconds * SR);
  let t = 0.3, seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  while (t < seconds - 0.3) {
    const beat = 60 / (t < change ? bpm1 : bpm2), s0 = Math.floor(t * SR);
    for (let i = 0; i < 0.25 * SR && s0 + i < out.length; i++) out[s0 + i] += Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-i / SR * 30)) * i / SR) * Math.exp(-i / SR * 25) * 0.8;
    const h = Math.floor((t + beat / 2) * SR);
    for (let i = 0; i < 0.04 * SR && h + i < out.length; i++) out[h + i] += noise() * 0.25 * Math.exp(-i / SR * 80);
    t += beat;
  }
  return out;
}

describe('tempo changes', () => {
  it('a steady song gets one red line', () => {
    expect(estimateTiming(analyze(track(90, 150, 150, 999), SR))).toHaveLength(1);
  });
  it('a short clip always gets one red line', () => {
    expect(estimateTiming(analyze(track(45, 127, 124, 6), SR))).toHaveLength(1);
  });
  it('a clear change in a long song becomes a second red line near the change', () => {
    const lines = estimateTiming(analyze(track(100, 140, 175, 50), SR));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const second = lines[1];
    expect(Math.abs(60000 / second.beatLength - 175)).toBeLessThan(2);
    expect(Math.abs(second.time - 50000)).toBeLessThan(4000);
  });
});
