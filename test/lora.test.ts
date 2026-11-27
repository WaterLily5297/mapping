import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { buildDataset } from '../src/lora/dataset';
import { buildArgs, listLoras, resolveLora } from '../src/ai/mapperatorinator';
import { createBeatmap, makeNote, writeOsu, parseOsu, osuFileName } from '../src/core/beatmap';

let dir: string;

function chart(keys: number, title: string, audio = 'audio.mp3') {
  const m = createBeatmap({ keys, bpm: 180, offset: 0, title, artist: 'tester', audioFilename: audio, version: `${keys}K test` });
  for (let i = 0; i < 200; i++) {
    m.notes.push(makeNote(1000 + i * 83, i % keys));
    if (i % 2 === 0) m.notes.push(makeNote(1000 + i * 83, (i + 2) % keys));
  }
  return m;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'maniamap-lora-test-'));
  // an .osz with a 7K and a 4K diff
  const a = chart(7, 'Song A');
  const b = chart(4, 'Song A');
  writeFileSync(join(dir, 'a.osz'), zipSync({
    [osuFileName(a)]: strToU8(writeOsu(a)), [osuFileName(b)]: strToU8(writeOsu(b)), 'audio.mp3': strToU8('fake mp3'),
  }));
  // a folder set with a real BeatmapID
  const c = chart(7, 'Song B', 'song.ogg');
  c.metadata.set('BeatmapID', '123456');
  c.metadata.set('BeatmapSetID', '654321');
  mkdirSync(join(dir, 'songs', 'B'), { recursive: true });
  writeFileSync(join(dir, 'songs', 'B', 'b.osu'), writeOsu(c));
  writeFileSync(join(dir, 'songs', 'B', 'song.ogg'), 'fake ogg');
  // a set whose audio is missing
  mkdirSync(join(dir, 'songs', 'C'), { recursive: true });
  writeFileSync(join(dir, 'songs', 'C', 'c.osu'), writeOsu(chart(7, 'Song C', 'missing.mp3')));
  // a non-mania file
  writeFileSync(join(dir, 'songs', 'B', 'std.osu'), 'osu file format v14\n\n[General]\nMode: 0\nAudioFilename: song.ogg\n\n[Difficulty]\nCircleSize:4\n\n[HitObjects]\n256,192,1000,1,0,0:0:0:0:\n');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('LoRA dataset builder', () => {
  it('collects mania maps from .osz and folders, filters keys, tags and ids', () => {
    const out = join(dir, 'ds');
    const logs: string[] = [];
    const entries = buildDataset({ inputs: [join(dir, 'a.osz'), join(dir, 'songs')], out, keys: [7], extraTags: ['style/o2jam'], log: (s) => logs.push(s) });
    expect(entries.map((e) => e.Keys)).toEqual([7, 7]);
    // missing audio is reported, non-mania skipped silently
    expect(logs.some((l) => /skip .*missing/.test(l))).toBe(true);
    // real ids are kept, synthetic ids are far above real osu! ids
    const real = entries.find((e) => e.Id === 123456)!;
    expect(real.BeatmapSetId).toBe(654321);
    const synth = entries.find((e) => e.Id !== 123456)!;
    expect(synth.Id).toBeGreaterThan(1_900_000_000);
    // every map carries the extra tag and classifier tags in the model vocabulary
    for (const e of entries) {
      expect(e.OmdbTags).toContain('style/o2jam');
      expect(e.OmdbTags.length).toBeGreaterThan(1);
      // the .osu on disk has the id written in, and points at the copied audio
      const osu = parseOsu(readFileSync(join(out, 'data', e.BeatmapSetFolder, e.BeatmapFile), 'utf8'));
      expect(Number(osu.metadata.get('BeatmapID'))).toBe(e.Id);
      expect(osu.general.get('AudioFilename')).toBe(e.AudioFile);
      expect(existsSync(join(out, 'data', e.BeatmapSetFolder, e.AudioFile))).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.beatmaps).toHaveLength(2);
  });

  it('rejects unknown extra tags', () => {
    expect(() => buildDataset({ inputs: [join(dir, 'a.osz')], out: join(dir, 'ds2'), extraTags: ['style/nope'] })).toThrow(/unknown style tag/);
  });
});

describe('LoRA store and inference args', () => {
  it('lists and resolves LoRAs, passes lora_path', () => {
    const store = join(dir, 'store');
    mkdirSync(join(store, 'mine'), { recursive: true });
    writeFileSync(join(store, 'mine', 'adapter_config.json'), '{}');
    writeFileSync(join(store, 'mine', 'maniamap.json'), JSON.stringify({ beatmaps: 42, keys: [7] }));
    mkdirSync(join(store, 'not-a-lora'));
    const prev = process.env.MANIAMAP_LORA_DIR;
    process.env.MANIAMAP_LORA_DIR = store;
    try {
      expect(listLoras().map((l) => l.name)).toEqual(['mine']);
      expect(listLoras()[0].info).toMatchObject({ beatmaps: 42 });
      expect(resolveLora('mine')).toBe(join(store, 'mine'));
      expect(() => resolveLora('other')).toThrow(/available: mine/);
      expect(buildArgs({ audioPath: '/a.mp3', keys: 7, loraPath: join(store, 'mine') }, '/out')).toContain(`lora_path='${join(store, 'mine')}'`);
    } finally {
      if (prev === undefined) delete process.env.MANIAMAP_LORA_DIR; else process.env.MANIAMAP_LORA_DIR = prev;
    }
  });
});

describe('free cloud-GPU notebook and LoRA import', () => {
  it('makes a valid notebook that embeds the trainer and the settings', async () => {
    const { makeNotebook } = await import('../src/lora/notebook');
    const script = 'print("trainer")\nx = "quotes \' and \\" and \\\\ backslash"\n';
    const nb = JSON.parse(makeNotebook({ name: 'my-style', trainScript: script, steps: 123, batch: 2, gradAcc: 16, rank: 32 }));
    expect(nb.nbformat).toBe(4);
    const code = nb.cells.filter((c: { cell_type: string }) => c.cell_type === 'code').map((c: { source: string[] }) => c.source.join('')).join('\n');
    expect(code).toContain('STEPS = 123');
    expect(code).toContain('RANK = 32');
    expect(code).toContain('TRAIN.write_text(' + JSON.stringify(script) + ')');
    expect(code).not.toMatch(/^!/m); // plain Python, runs anywhere
    expect(nb.cells[0].source.join('')).toContain('my-style-dataset.zip');
  });

  it('imports a LoRA zip (also from a sub-folder) and rejects other zips', async () => {
    const { importLora } = await import('../src/lora/notebook');
    const store = join(dir, 'store2');
    const z = join(dir, 'x-lora.zip');
    writeFileSync(z, zipSync({ 'nested/adapter_config.json': strToU8('{}'), 'nested/adapter_model.safetensors': strToU8('w'), 'README.txt': strToU8('r') }));
    const dest = importLora(z, store, 'imported');
    expect(existsSync(join(dest, 'adapter_config.json'))).toBe(true);
    expect(existsSync(join(dest, 'adapter_model.safetensors'))).toBe(true);
    expect(existsSync(join(dest, 'README.txt'))).toBe(false);
    const bad = join(dir, 'bad.zip');
    writeFileSync(bad, zipSync({ 'a.txt': strToU8('x') }));
    expect(() => importLora(bad, store, 'bad')).toThrow(/adapter_config/);
    expect(() => importLora(z, store, '../evil')).toThrow(/--name/);
  });
});
