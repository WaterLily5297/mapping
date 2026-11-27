import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mugRequest, mugPatternsForStyle, findMugInstall } from '../src/ai/mug';
import { postprocessAiMap } from '../src/ai/postprocess';
import { createBeatmap, makeNote, writeOsu } from '../src/core/beatmap';

describe('MuG Diffusion bridge', () => {
  it('builds the prompt the web UI would send', () => {
    const r = mugRequest({ audioPath: '/a.mp3', stars: 4.2, patterns: { jumpstream: 'more' }, bpm: 174, offset: 308, seed: 3 }, '/out');
    expect(r).toMatchObject({ audio: '/a.mp3', out_dir: '/out', sr: 4.2, rank_status: 'ranked', map_type: 'rc', patterns: { jumpstream: 'more' }, bpm: 174, offset: 308, seed: 3, steps: 50, cfg: 5, rm_jacks_ms: 90 });
    expect(r.ln_ratio).toBeUndefined();
  });

  it('maps the LN amount to rice / hybrid / LN maps', () => {
    expect(mugRequest({ audioPath: 'a', stars: 3 }, 'o').map_type).toBe('rc');
    expect(mugRequest({ audioPath: 'a', stars: 3, lnRatio: 0.25 }, 'o')).toMatchObject({ map_type: 'hb', ln_ratio: 0.25 });
    expect(mugRequest({ audioPath: 'a', stars: 3, lnRatio: 0.6 }, 'o')).toMatchObject({ map_type: 'ln', ln_ratio: 0.6 });
    // MuG's star range
    expect(mugRequest({ audioPath: 'a', stars: 20 }, 'o').sr).toBe(12);
  });

  it('maps maniamap styles to MuG pattern prompts', () => {
    expect(mugPatternsForStyle('stream')).toEqual({ stream: 'more' });
    expect(mugPatternsForStyle('chordjack')).toEqual({ chordjack: 'more' });
    expect(mugPatternsForStyle('tech')).toEqual({ technical: 'more' });
    expect(mugPatternsForStyle('auto')).toBeUndefined();
  });

  it('reports a missing install clearly', () => {
    const r = findMugInstall(mkdtempSync(join(tmpdir(), 'nomug-')));
    expect(r.available).toBe(false);
    expect(r.problem).toContain('maniamap setup mug');
  });

  it('keeps MuG Diffusion attribution when post-processing', () => {
    const m = createBeatmap({ keys: 4, bpm: 174, title: 't' });
    m.metadata.set('Creator', 'MuG Diffusion v1.0.0');
    for (let i = 0; i < 40; i++) m.notes.push(makeNote(1000 + i * 86, i % 4));
    const post = postprocessAiMap(writeOsu(m), { keys: 4, engine: 'mug' });
    expect(post.map.metadata.get('Tags')).toContain('mug-diffusion');
    expect(post.map.metadata.get('Tags')).not.toContain('mapperatorinator');
    expect(post.map.metadata.get('Creator')).toBe('MuG Diffusion v1.0.0');
  });
});
