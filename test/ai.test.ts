import { describe, it, expect } from 'vitest';
import { buildArgs, hq, findAiInstall } from '../src/ai/mapperatorinator';
import { toModelDescriptors, MANIA_DESCRIPTORS } from '../src/ai/descriptors';
import { postprocessAiMap } from '../src/ai/postprocess';
import { MAPPERS, referenceMappers, mapperFit } from '../src/ai/mappers';
import { createBeatmap, makeNote, writeOsu, getKeys } from '../src/core/beatmap';

describe('Mapperatorinator bridge', () => {
  it('quotes Hydra values safely (spaces, quotes, backslashes)', () => {
    expect(hq("/music/It's a song.mp3")).toBe("'/music/It\\'s a song.mp3'");
    expect(hq('C:\\osu\\Songs')).toBe("'C:\\\\osu\\\\Songs'");
  });

  it('builds mania arguments', () => {
    const a = buildArgs({
      audioPath: '/tmp/a b.mp3', keys: 7, stars: 4.2, holdNoteRatio: 0.3,
      descriptors: ['style/jumpstream', 'style/LN mixed'], seed: 5, startTime: 1000, endTime: 20000,
    }, '/tmp/out', '/tmp/ref.osu');
    expect(a[0]).toBe('inference.py');
    expect(a).toContain('gamemode=3');
    expect(a).toContain('keycount=7');
    expect(a).toContain('difficulty=4.2');
    expect(a).toContain('hold_note_ratio=0.3');
    expect(a).toContain("audio_path='/tmp/a b.mp3'");
    // the model spells this tag with a trailing space
    expect(a).toContain("descriptors=['style/jumpstream','style/LN mixed ']");
    expect(a).toContain("beatmap_path='/tmp/ref.osu'");
    expect(a).toContain('in_context=[TIMING]');
    expect(a).toContain('start_time=1000');
    expect(a).toContain('end_time=20000');
  });

  it('passes a reference mapper to the model', () => {
    const a = buildArgs({ audioPath: '/tmp/a.mp3', keys: 4, stars: 6, mapperId: 2193881 }, '/tmp/out');
    expect(a).toContain('mapper_id=2193881');
    // the short-lookback window that keeps dense charts from running out of tokens
    expect(a).toContain('lookback=0.2');
    expect(a).toContain('lookahead=0.7');
    expect(buildArgs({ audioPath: '/tmp/a.mp3', keys: 4, lookback: 0.5, lookahead: 0.4 }, '/tmp/out')).toEqual(expect.arrayContaining(['lookback=0.5', 'lookahead=0.4']));
    expect(buildArgs({ audioPath: '/tmp/a.mp3', keys: 4 }, '/tmp/out').some((x) => x.startsWith('mapper_id'))).toBe(false);
    // model choice: V32-mini is a Hydra config name, right after the script
    expect(buildArgs({ audioPath: '/tmp/a.mp3', keys: 4, model: 'v32-mini' }, '/tmp/out').slice(0, 2)).toEqual(['inference.py', '--config-name=v32-mini']);
    expect(buildArgs({ audioPath: '/tmp/a.mp3', keys: 4 }, '/tmp/out')[1]).not.toContain('config-name');
  });

  it('picks reference mappers the model knows, fitting keys and stars', () => {
    expect(MAPPERS.length).toBeGreaterThan(100);
    const four = referenceMappers(4, 7);
    expect(four.length).toBeGreaterThan(3);
    for (const m of four) {
      expect(m.name).toBeTruthy();
      expect(m.byKeys['4']).toBeDefined();
      expect(mapperFit(m, 4, 7)).toBeGreaterThan(0.5);
    }
    const seven = referenceMappers(7, 9.5);
    expect(seven[0].byKeys['7'].max).toBeGreaterThan(8);
    // excluded mappers (e.g. the song's own) are never picked
    expect(referenceMappers(4, 7, [four[0].id]).some((m) => m.id === four[0].id)).toBe(false);
  });

  it('rejects unknown style tags and bad key counts', () => {
    expect(() => toModelDescriptors(['style/not-a-tag'])).toThrow(/unknown style tag/);
    expect(() => buildArgs({ audioPath: 'x', keys: 0 }, '/o')).toThrow(/keys/);
    expect(MANIA_DESCRIPTORS.length).toBeGreaterThan(25);
  });

  it('reports a missing install clearly', () => {
    const i = findAiInstall('/nonexistent/Mapperatorinator');
    expect(i.available).toBe(false);
    expect(i.problem).toMatch(/maniamap setup ai/);
  });

  it('post-processes a generated map: keys, overlaps, metadata, AI disclosure, style check', () => {
    const m = createBeatmap({ keys: 4, bpm: 180, offset: 0, creator: 'Mapperatorinator' });
    for (let i = 0; i < 400; i++) m.notes.push(makeNote(1000 + i * 83, i % 4), makeNote(1000 + i * 83, (i + 2) % 4));
    m.notes.push(makeNote(1000, 0)); // a stacked duplicate the AI might produce
    const r = postprocessAiMap(writeOsu(m), {
      keys: 4, stars: 4, audioFilename: 'song.mp3', title: 'Song', requestedTags: ['style/jumpstream', 'style/chordjack'],
    });
    expect(getKeys(r.map)).toBe(4);
    expect(r.removedOverlaps).toBe(1);
    expect(r.errors).toBe(0);
    expect(r.map.metadata.get('Tags')).toContain('ai-generated');
    expect(r.map.metadata.get('Version')).toBe('4K AI 4*');
    expect(r.map.general.get('AudioFilename')).toBe('song.mp3');
    const check = Object.fromEntries(r.styleCheck.map((c) => [c.tag, c.matched]));
    expect(check['style/jumpstream']).toBe(true);
    expect(check['style/chordjack']).toBe(false);
  });
});

describe('AI output clean-up', () => {
  it('turns a long note snapped to zero length into a plain note', async () => {
    const { postprocessAiMap } = await import('../src/ai/postprocess');
    const { createBeatmap, makeNote, writeOsu } = await import('../src/core/beatmap');
    const { validate } = await import('../src/tools/transforms');
    const raw = createBeatmap({ keys: 7, bpm: 120, offset: 0 });
    raw.notes = [makeNote(1000, 5), makeNote(3000, 4)];
    // the AI's file: the note at 3000 ms is a long note ending at 3000 ms
    const text = writeOsu(raw).replace(/^(\d+),192,3000,1,0,/m, '$1,192,3000,128,0,3000:');
    expect(text).toContain(',3000,128,0,3000:');
    const r = postprocessAiMap(text, { keys: 7 });
    expect(r.errors).toBe(0);
    expect(validate(r.map).filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(r.map.notes.find((n) => n.time === 3000)?.endTime).toBeUndefined();
  });
});

describe('AI threads', () => {
  it('leaves one CPU core free and keeps thread settings the user made', async () => {
    const { cpuThreadEnv } = await import('../src/ai/mapperatorinator');
    expect(cpuThreadEnv(4, {})).toEqual({ OMP_NUM_THREADS: '3', MKL_NUM_THREADS: '3', OPENBLAS_NUM_THREADS: '3' });
    expect(cpuThreadEnv(1, {}).OMP_NUM_THREADS).toBe('1');
    expect(cpuThreadEnv(8, { OMP_NUM_THREADS: '2' }).OMP_NUM_THREADS).toBeUndefined();
  });
});

describe('half-finished AI setups and failures', () => {
  it('an environment without a finished setup is not an install', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { findAiInstall, SETUP_MARKER } = await import('../src/ai/mapperatorinator');
    const dir = mkdtempSync(join(tmpdir(), 'mai-half-'));
    writeFileSync(join(dir, 'inference.py'), '');
    mkdirSync(join(dir, '.venv', 'bin'), { recursive: true });
    // a "python" that cannot import anything, as after a stopped setup
    symlinkSync('/bin/false', join(dir, '.venv', 'bin', 'python'));
    const half = findAiInstall(dir);
    expect(half.available).toBe(false);
    expect(half.problem).toMatch(/did not finish/);
    writeFileSync(join(dir, SETUP_MARKER), 'done');
    expect(findAiInstall(dir).available).toBe(true);
  });

  it('says why the AI stopped in one line, with what to do', async () => {
    const { explainAiFailure } = await import('../src/ai/mapperatorinator');
    const log = ['Traceback (most recent call last):', '  File "inference.py", line 3', "ModuleNotFoundError: No module named 'torch'", 'Set the environment variable HYDRA_FULL_ERROR=1 for a complete stack trace.'];
    expect(explainAiFailure(log)).toMatch(/No module named 'torch'.*Set up the AI/);
    expect(explainAiFailure(['loading', 'RuntimeError: CUDA out of memory'])).toMatch(/memory/);
    expect(explainAiFailure([])).toBe('no output');
  });
});
