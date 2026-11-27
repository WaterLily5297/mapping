import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTar, fetchManiaData, matches, type ApiBeatmap } from '../src/data/fetch';
import { createBeatmap, makeNote, writeOsu, parseOsu } from '../src/core/beatmap';

/** build a ustar archive in memory */
function tar(entries: [string, string | Buffer][]): Buffer {
  const parts: Buffer[] = [];
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

async function* chunks(b: Buffer, size = 777) {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}

function api(over: Partial<ApiBeatmap>, keys: number, mode = 3): ApiBeatmap {
  const m = createBeatmap({ keys, bpm: 180, title: 'T', artist: 'A', audioFilename: 'audio.mp3' });
  m.general.set('Mode', String(mode));
  for (let i = 0; i < 64; i++) m.notes.push(makeNote(1000 + i * 100, i % keys));
  return {
    beatmapset_id: 1, beatmap_id: 10, approved: 1, version: 'Hard', diff_size: keys, mode, count_normal: 64, count_slider: 0,
    approved_date: '2021-05-01 00:00:00', submit_date: null, artist: 'A', title: 'T', creator: 'Someone', creator_id: 42,
    difficultyrating: 3.2, content: writeOsu(m), ...over,
  };
}

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('dataset fetcher', () => {
  it('reads a tar stream split into arbitrary chunks', async () => {
    const b = tar([['000000.json', '{"a":1}'], ['000000.opus', Buffer.alloc(1500, 7)]]);
    const got: [string, number][] = [];
    for await (const e of readTar(chunks(b))) got.push([e.name, e.data.length]);
    expect(got).toEqual([['000000.json', 7], ['000000.opus', 1500]]);
  });

  it('filters', () => {
    expect(matches(api({}, 4), { keys: [4] })).toBe(true);
    expect(matches(api({}, 4), { keys: [7] })).toBe(false);
    expect(matches(api({}, 4, 0), {})).toBe(false); // not mania
    expect(matches(api({ difficultyrating: 6 }, 4), { maxStars: 5 })).toBe(false);
    expect(matches(api({ creator: 'someone' }, 4), { mappers: ['SOMEONE'] })).toBe(true);
    expect(matches(api({ count_normal: 50, count_slider: 50 }, 4), { minLn: 0.4 })).toBe(true);
    expect(matches(api({}, 4), { fromYear: 2022 })).toBe(false);
  });

  it('keeps matching mania maps with their audio, tolerates NaN, skips the rest', async () => {
    const out = mkdtempSync(join(tmpdir(), 'maniamap-fetch-'));
    dirs.push(out);
    const s1 = JSON.stringify({ audio_hash: 'x', audio_length: 10, beatmaps: [api({ beatmap_id: 11 }, 4), api({ beatmap_id: 12 }, 7), api({ beatmap_id: 13 }, 4, 0)] })
      .replace('"difficultyrating":3.2', '"difficultyrating":3.2,"diff_aim":NaN');
    const s2 = JSON.stringify({ beatmaps: [api({ beatmap_id: 21, beatmapset_id: 2 }, 4, 0)] });
    const shard = tar([['000000.json', s1], ['000000.opus', Buffer.from('opus-audio')], ['000001.json', s2], ['000001.opus', Buffer.from('skip me')]]);
    const r = await fetchManiaData({ out, maxMaps: 10, filter: { keys: [4] }, maxShards: 1, open: () => ({ stream: chunks(shard), close() {} }) });
    expect(r).toMatchObject({ maps: 1, sets: 1, shardsRead: 1 });
    const set = readdirSync(out).find((d) => d.startsWith('1 '))!;
    const files = readdirSync(join(out, set)).sort();
    expect(files).toContain('audio.opus');
    const osuFile = files.find((f) => f.endsWith('.osu'))!;
    expect(parseOsu(readFileSync(join(out, set, osuFile), 'utf8')).general.get('AudioFilename')).toBe('audio.opus');
    const src = JSON.parse(readFileSync(join(out, set, 'maniamap-source.json'), 'utf8'));
    expect(src.beatmaps[0]).toMatchObject({ beatmap_id: 11, creator_id: 42, keys: 4 });
    // a finished shard is remembered and skipped next time
    const again = await fetchManiaData({ out, maxMaps: 10, filter: { keys: [4] }, maxShards: 1, open: () => { throw new Error('should not reopen'); } });
    expect(again.shardsRead).toBe(0);
  });
});
