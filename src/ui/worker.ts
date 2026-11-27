/// <reference lib="webworker" />
/**
 * Background worker for the Generate screen: audio analysis, tempo, generation and chart
 * reports run here so the page stays smooth.
 */
import { analyze, analyzeStereo, estimateTempo, stereoWidth, type Analysis } from '../automap/analysis';
import { generateBestOf } from '../automap/target';
import { detectTiming, toTimingPoints, TEMPO_CHANGES } from '../automap/tempomap';
import { type StyleChoice, loudnessForMap } from '../automap/generate';
import { parseOsu, type TimingPoint } from '../core/beatmap';
import { fitDifficulty } from '../tools/difficultyfit';
import { report } from './report';
export type { Report } from './report';

export interface GenRequest {
  keys: number;
  stars: number;
  style: StyleChoice;
  bpm: number;
  offset: number;
  lnRatio?: number;
  seed: number;
  pitchFollow?: number;
  /** sound direction: lanes follow the stereo position or the pitch (auto: stereo for panned mixes) */
  direction?: 'auto' | 'stereo' | 'pitch';
  /** red lines from a dropped .osz (songs with tempo changes) */
  timing?: TimingPoint[];
  metadata: { title?: string; artist?: string; creator?: string; version?: string; audioFilename?: string };
}

export type WorkerIn =
  | { id: number; type: 'analyze'; samples: Float32Array; rate: number; left?: Float32Array; right?: Float32Array }
  | { id: number; type: 'generate'; req: GenRequest }
  | { id: number; type: 'report'; osu: string }
  | { id: number; type: 'fit'; osu: string; stars: number };

let analysis: Analysis | null = null;

const post = (msg: unknown) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  try {
    if (m.type === 'analyze') {
      analysis = m.left && m.right ? analyzeStereo(m.left, m.right, m.rate) : analyze(m.samples, m.rate);
      const t = estimateTempo(analysis);
      const beat = 60000 / t.bpm;
      const lines = TEMPO_CHANGES ? detectTiming(analysis) : [];
      post({ id: m.id, ok: true, bpm: t.bpm, offset: ((t.offset % beat) + beat) % beat, confidence: t.confidence, stereoWidth: stereoWidth(analysis),
        timing: lines.length > 1 ? toTimingPoints(lines) : null });
    } else if (m.type === 'generate') {
      if (!analysis) throw new Error('load a song first');
      const r = m.req;
      // best of several seeds by the quality score (cleaner, closer to the star target)
      const res = generateBestOf(analysis, {
        keys: r.keys, targetStars: r.stars, style: r.style, bpm: r.bpm, offset: r.offset, seed: r.seed,
        lnRatio: r.lnRatio, pitchFollow: r.pitchFollow, direction: r.direction, metadata: r.metadata, timingPoints: r.timing,
      });
      if (r.metadata.version) res.map.metadata.set('Version', r.metadata.version);
      post({ id: m.id, ok: true, reached: res.reached, report: report(res.map) });
    } else if (m.type === 'report') {
      post({ id: m.id, ok: true, report: report(parseOsu(m.osu)) });
    } else if (m.type === 'fit') {
      const src = parseOsu(m.osu);
      // contrast-aware when the song is loaded: thin quiet parts first, add in loud parts
      const f = fitDifficulty(src, m.stars, analysis ? { loudness: loudnessForMap(analysis, src) } : {});
      post({ id: m.id, ok: true, reached: f.reached, report: report(f.map) });
    }
  } catch (err) {
    post({ id: m.id, ok: false, error: (err as Error).message });
  }
};
