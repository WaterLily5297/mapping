import { describe, it, expect } from 'vitest';
import {
  parseOsu, writeOsu, columnToX, xToColumn, createBeatmap, makeNote, getKeys,
} from '../src/core/beatmap';
import { snapTime, gridTicks, svAt } from '../src/core/timing';
import * as T from '../src/tools/transforms';

const SAMPLE = `osu file format v14

[General]
AudioFilename: audio.mp3
AudioLeadIn: 0
PreviewTime: 1000
Mode: 3

[Editor]
BeatDivisor: 4

[Metadata]
Title:Test Song
Artist:Someone
Creator:me
Version:4K Hard

[Difficulty]
HPDrainRate:8
CircleSize:4
OverallDifficulty:8
ApproachRate:5
SliderMultiplier:1.4
SliderTickRate:1

[Events]
//Background and Video events
0,0,"bg.jpg",0,0

[TimingPoints]
100,500,4,2,0,60,1,0
2100,-50,4,2,0,60,0,0

[HitObjects]
64,192,100,1,0,0:0:0:0:
192,192,100,5,0,0:0:0:0:
320,192,600,128,2,1100:0:0:0:0:
448,192,725,1,0,0:0:0:0:hit.wav
64,192,850,1,0,0:0:0:0:
`;

describe('column <-> x', () => {
  it('round-trips for every key count 1..18', () => {
    for (let k = 1; k <= 18; k++) {
      for (let c = 0; c < k; c++) expect(xToColumn(columnToX(c, k), k)).toBe(c);
    }
  });
  it('matches osu! values for 4K and 7K', () => {
    expect([0, 1, 2, 3].map((c) => columnToX(c, 4))).toEqual([64, 192, 320, 448]);
    expect([0, 1, 2, 3, 4, 5, 6].map((c) => columnToX(c, 7))).toEqual([36, 109, 182, 256, 329, 402, 475]);
  });
});

describe('parse / write', () => {
  const map = parseOsu(SAMPLE);
  it('parses notes, LNs, keys, metadata', () => {
    expect(getKeys(map)).toBe(4);
    expect(map.notes).toHaveLength(5);
    const ln = map.notes.find((n) => n.endTime)!;
    expect(ln).toMatchObject({ time: 600, column: 2, endTime: 1100, hitSound: 2 });
    expect(map.notes.find((n) => n.time === 725)!.hitSample).toBe('0:0:0:0:hit.wav');
    expect(map.metadata.get('Title')).toBe('Test Song');
    expect(map.timingPoints).toHaveLength(2);
  });
  it('round-trips losslessly', () => {
    const again = parseOsu(writeOsu(map));
    expect(again.notes).toEqual(map.notes);
    expect(again.timingPoints).toEqual(map.timingPoints);
    expect(again.rawSections.get('Events')).toEqual(map.rawSections.get('Events'));
    expect(writeOsu(again)).toBe(writeOsu(map));
  });
  it('keeps the new-combo bit', () => {
    expect(writeOsu(map)).toContain('192,192,100,5,0,0:0:0:0:');
  });
  it('rejects non-mania maps', () => {
    expect(() => parseOsu(SAMPLE.replace('Mode: 3', 'Mode: 0'))).toThrow(/mania/);
  });
});

describe('timing', () => {
  const map = parseOsu(SAMPLE);
  it('snaps to divisors', () => {
    expect(snapTime(map, 230, 4)).toBe(225);
    expect(snapTime(map, 260, 2)).toBe(350);
    expect(snapTime(map, 260, 3)).toBe(267);
  });
  it('builds grid ticks with measure/beat kinds', () => {
    const t = gridTicks(map, 100, 600, 2);
    expect(t.map((x) => x.time)).toEqual([100, 350, 600]);
    expect(t.map((x) => x.kind)).toEqual([0, 2, 1]);
  });
  it('reads SV', () => {
    expect(svAt(map, 1000)).toBe(1);
    expect(svAt(map, 3000)).toBe(2);
  });
});

describe('tools', () => {
  const map = parseOsu(SAMPLE);
  it('mirror', () => {
    const m = T.mirror(map);
    expect(m.notes.map((n) => n.column).sort()).toEqual(map.notes.map((n) => 3 - n.column).sort());
    expect(map.notes[0].column).toBe(0); // input untouched
  });

  it('convertKeys works for every pair 1..18 without overlaps', () => {
    // a dense random 7K chart
    const src = createBeatmap({ keys: 7, bpm: 180 });
    for (let i = 0; i < 400; i++) {
      const t = 1000 + i * 83;
      src.notes.push(makeNote(t, (i * 5) % 7));
      if (i % 3 === 0) src.notes.push(makeNote(t, (i * 5 + 3) % 7));
      if (i % 11 === 0) src.notes.push(makeNote(t + 1, (i + 1) % 7, t + 300));
    }
    const fixed = T.fixOverlaps(src);
    for (const target of [1, 4, 5, 6, 7, 8, 10, 12, 18]) {
      const out = T.convertKeys(fixed, target);
      expect(getKeys(out)).toBe(target);
      expect(out.notes.every((n) => n.column >= 0 && n.column < target)).toBe(true);
      expect(T.validate(out).filter((i) => i.severity === 'error')).toEqual([]);
      if (target >= 7) expect(out.notes.length).toBe(fixed.notes.length);
    }
  });

  it('up-conversion uses every column', () => {
    const src = createBeatmap({ keys: 4, bpm: 150 });
    for (let i = 0; i < 200; i++) src.notes.push(makeNote(i * 100, i % 4));
    const out = T.convertKeys(src, 7);
    expect(new Set(out.notes.map((n) => n.column)).size).toBe(7);
  });

  it('fullLN / removeLNs / quantize', () => {
    const ln = T.fullLN(map);
    expect(ln.notes.filter((n) => n.endTime).length).toBeGreaterThan(2);
    expect(T.validate(ln).filter((i) => i.severity === 'error')).toEqual([]);
    expect(T.removeLNs(ln).notes.some((n) => n.endTime)).toBe(false);
    const q = T.quantize({ ...map, notes: [...map.notes, makeNote(233, 3)] }, 4);
    expect(q.notes.some((n) => n.time === 225 && n.column === 3)).toBe(true);
  });

  it('validate finds overlaps and unsnapped notes', () => {
    const bad = T.quantize(map, 4);
    bad.notes.push(makeNote(700, 2)); // inside the LN 600..1100 in column 2
    bad.notes.push(makeNote(1313, 0)); // unsnapped
    const msgs = T.validate(bad).map((i) => i.message);
    expect(msgs).toContain('Note overlaps a long note.');
    expect(msgs).toContain('Unsnapped note (not on 1/16 or 1/12).');
    expect(T.validate(T.fixOverlaps(bad)).some((i) => i.severity === 'error')).toBe(false);
  });

  it('changeRate scales timing', () => {
    const r = T.changeRate(map, 1.25);
    expect(r.notes[0].time).toBe(80);
    expect(r.timingPoints[0].beatLength).toBe(400);
  });

  it('stats', () => {
    const s = T.stats(map);
    expect(s).toMatchObject({ keys: 4, notes: 5, lns: 1, mainBpm: 120 });
    expect(s.chordSizes[1]).toBe(1);
  });
});
