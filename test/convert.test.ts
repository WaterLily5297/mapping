import { describe, it, expect } from 'vitest';
import { createBeatmap, makeNote, getKeys, isLN, type Beatmap } from '../src/core/beatmap';
import { convertKeys, convertKeysSmart, convertKeysSimple, lnConvert, validate, dirt } from '../src/tools/transforms';
import { monotoneMappings } from '../src/tools/keyconvert';
import { classifyPatterns } from '../src/analysis/patterns';
import { rng } from '../src/core/rng';

const BPM = 180;
const Q = 60000 / BPM / 4;

/** a jumpstream-ish chart without jacks (like real 4K maps), any key count */
function chart(keys: number, rows = 400, seed = 1, chords = [1, 2, 1, 1, 2]): Beatmap {
  const m = createBeatmap({ keys, bpm: BPM, offset: 0 });
  const rand = rng(seed);
  let prev: number[] = [];
  for (let i = 0; i < rows; i++) {
    const size = Math.min(chords[i % chords.length], keys - prev.length > 0 ? keys - prev.length : 1);
    const free = [...Array(keys).keys()].filter((c) => !prev.includes(c)).sort(() => rand() - 0.5);
    const cols = free.slice(0, size);
    for (const c of cols) m.notes.push(makeNote(1000 + i * Q, c));
    prev = cols;
  }
  return m;
}

describe('smart key converter', () => {
  it('only uses monotone mappings (keeps left-right order)', () => {
    for (const [n, m] of [[4, 7], [7, 4], [4, 4], [10, 6]]) {
      for (const map of monotoneMappings(n, m)) {
        expect(map).toHaveLength(n);
        for (let i = 1; i < n; i++) expect(map[i]).toBeGreaterThanOrEqual(map[i - 1]);
      }
    }
    expect(monotoneMappings(4, 7)).toHaveLength(35); // C(7,4)
    expect(monotoneMappings(7, 4)).toHaveLength(20); // C(6,3)
  });

  it('every key pair 1..18: valid, no new fast jacks, hands no worse than the source', () => {
    for (const from of [4, 6, 7, 10]) {
      const src = chart(from, 300, from);
      const before = dirt(src);
      for (const to of [1, 2, 4, 5, 7, 8, 10, 18]) {
        const out = convertKeys(src, to);
        expect(getKeys(out)).toBe(to);
        expect(validate(out).filter((i) => i.severity === 'error')).toEqual([]);
        if (to >= 4) {
          const d = dirt(out);
          expect(d.fastJacks, `${from}->${to}`).toBeLessThanOrEqual(before.fastJacks + 1);
          expect(d.handImbalance, `${from}->${to}`).toBeLessThan(before.handImbalance + 0.12);
        }
        if (to >= from) expect(out.notes.length).toBe(src.notes.length);
      }
    }
  });

  it('is much cleaner than the simple converter going down (7K -> 4K)', () => {
    const src = chart(7, 400, 3, [2, 1, 3, 1]);
    const smart = dirt(convertKeysSmart(src, 4));
    const simple = dirt(convertKeysSimple(src, 4));
    expect(smart.fastJacks).toBe(0);
    expect(simple.fastJacks).toBeGreaterThan(smart.fastJacks);
  });

  it('keeps pattern shapes: a trill stays a trill, a jumptrill stays a jumptrill', () => {
    for (const [pat, type] of [[[[0], [1]], 'trill'], [[[0, 1], [2, 3]], 'jumptrill']] as [number[][], string][]) {
      const m = createBeatmap({ keys: 4, bpm: BPM, offset: 0 });
      for (let i = 0; i < 64; i++) for (const c of pat[i % 2]) m.notes.push(makeNote(1000 + i * Q, c));
      const out = convertKeys(m, 7);
      expect(classifyPatterns(out).dominant[0]).toBe(type);
    }
  });

  it('uses every target column', () => {
    const out = convertKeys(chart(4, 400), 7);
    expect(new Set(out.notes.map((n) => n.column)).size).toBe(7);
  });

  it('spreadJacks removes the source jacks when adding keys; fill adds clean chord notes', () => {
    const m = createBeatmap({ keys: 4, bpm: BPM, offset: 0 });
    const pat = [[0], [0], [1], [2], [2], [3], [1], [1]];
    for (let i = 0; i < 256; i++) for (const c of pat[i % pat.length]) m.notes.push(makeNote(1000 + i * Q * 2, c));
    expect(dirt(m).jacks).toBeGreaterThan(100);
    const spread = convertKeys(m, 7, { spreadJacks: true });
    expect(dirt(spread).jacks).toBe(0);
    const filled = convertKeys(chart(4, 300), 7, { fill: 0.5 });
    expect(filled.notes.length).toBeGreaterThan(chart(4, 300).notes.length);
    expect(dirt(filled).fastJacks).toBe(0);
    expect(validate(filled).filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('smart LN converter', () => {
  const src = chart(4, 400, 9);
  const share = (m: Beatmap) => m.notes.filter(isLN).length / m.notes.length;

  it('presets go from few to many LNs, all clean', () => {
    const shares = (['light', 'hybrid', 'full'] as const).map((p) => {
      const out = lnConvert(src, { preset: p });
      const d = dirt(out);
      expect(d.shortLNs, p).toBe(0);
      expect(d.tightReleases, p).toBe(0);
      expect(d.offGridReleases, p).toBe(0);
      expect(d.lockedHolds, p).toBe(0);
      expect(validate(out).filter((i) => i.severity === 'error'), p).toEqual([]);
      return share(out);
    });
    expect(shares[0]).toBeLessThan(shares[1]);
    expect(shares[1]).toBeLessThan(shares[2]);
    expect(shares[2]).toBeGreaterThan(0.5);
  });

  it('releases keep a safe gap before the next note in the column', () => {
    const out = lnConvert(src, { preset: 'full' });
    const byCol = new Map<number, typeof out.notes>();
    for (const n of out.notes) byCol.set(n.column, [...(byCol.get(n.column) ?? []), n]);
    for (const col of byCol.values()) {
      for (let i = 0; i + 1 < col.length; i++) {
        if (isLN(col[i])) expect(col[i + 1].time - col[i].endTime!).toBeGreaterThanOrEqual(Q - 2);
      }
    }
  });

  it('keeps existing LNs and is deterministic per seed', () => {
    const m = chart(4, 100, 2);
    m.notes[5].endTime = m.notes[5].time + 200;
    const a = lnConvert(m, { preset: 'hybrid', seed: 3 });
    const b = lnConvert(m, { preset: 'hybrid', seed: 3 });
    expect(a.notes.find((n) => n.time === m.notes[5].time && n.column === m.notes[5].column)!.endTime).toBe(m.notes[5].time + 200);
    expect(a.notes).toEqual(b.notes);
  });
});
