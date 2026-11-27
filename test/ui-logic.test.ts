import { describe, it, expect } from 'vitest';
import { starColor, starTextColor, tierName, starGradient } from '../src/ui/stars';
import { report } from '../src/ui/report';
import { createBeatmap, makeNote, parseOsu } from '../src/core/beatmap';

describe('star colours', () => {
  it('follow the osu! spectrum at the stops', () => {
    expect(starColor(2)).toBe('rgb(79, 255, 213)');
    expect(starColor(4.2)).toBe('rgb(255, 128, 104)');
    expect(starColor(9.5)).toBe('#000000');
  });
  it('interpolate smoothly and give readable text', () => {
    const a = starColor(3), b = starColor(3.05);
    expect(a).not.toBe(b);
    expect(starTextColor(7)).toBe('#f6f05c');
    expect(starTextColor(2)).toContain('rgba(0, 0, 0');
    expect(starGradient(0.5, 10)).toMatch(/^linear-gradient\(90deg, rgb/);
  });
  it('names tiers', () => {
    expect([1.5, 2.3, 3.3, 4.6, 5.9, 7].map(tierName)).toEqual(['Easy', 'Normal', 'Hard', 'Insane', 'Expert', 'Expert+']);
  });
});

describe('chart report', () => {
  it('summarises a chart for the result screen', () => {
    const m = createBeatmap({ keys: 4, bpm: 180, offset: 0 });
    for (let i = 0; i < 400; i++) m.notes.push(makeNote(1000 + i * 83, [0, 2, 1, 3][i % 4], i % 16 === 0 ? 1000 + i * 83 + 300 : undefined));
    const r = report(m);
    expect(r.notes).toBe(400);
    expect(r.keys).toBe(4);
    expect(r.stars).toBeGreaterThan(0);
    expect(r.curve.length).toBeGreaterThan(10);
    expect(r.lns).toBe(25);
    expect(Object.values(r.mix).reduce((a, b) => a + b, 0)).toBeGreaterThan(0.5);
    expect(r.dirt.fastJacks).toBe(0);
    expect(parseOsu(r.osu).notes.length).toBe(400);
  });
});
