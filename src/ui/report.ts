/** Chart report for the Generate screen (stars, difficulty curve, pattern mix, clean check). */
import { writeOsu, type Beatmap, isLN } from '../core/beatmap';
import { starRating } from '../analysis/difficulty';
import { classifyPatterns, PATTERN_INFO } from '../analysis/patterns';
import { dirt } from '../tools/cleanliness';
import { stats } from '../tools/transforms';
import { rebirthToOfficial } from '../tools/difficultyfit';

export interface Report {
  osu: string;
  stars: number;
  osuStars: number;
  curve: number[];
  notes: number;
  lns: number;
  nps: number;
  peakNps: number;
  lengthMs: number;
  keys: number;
  mix: Record<string, number>;
  /** pattern sections over time: skill group per stretch of the chart */
  timeline: { start: number; end: number; group: string; name: string }[];
  category: string;
  dirt: { fastJacks: number; jacks: number; handImbalance: number; tightReleases: number; score: number };
}

export function report(map: Beatmap): Report {
  const sr = starRating(map, { curveStep: 250 });
  const s = stats(map);
  const pr = classifyPatterns(map);
  const d = dirt(map);
  const ln = map.notes.length ? map.notes.filter(isLN).length / map.notes.length : 0;
  return {
    osu: writeOsu(map), stars: sr.stars, osuStars: rebirthToOfficial(sr.stars, ln), curve: [...sr.curve],
    notes: s.notes, lns: s.lns, nps: s.avgNps, peakNps: s.peakNps, lengthMs: s.lastTime, keys: s.keys,
    mix: pr.byGroup as Record<string, number>, category: pr.category,
    timeline: pr.sections.map((sec) => ({ start: sec.start, end: sec.end, group: PATTERN_INFO[sec.type].group, name: PATTERN_INFO[sec.type].name })),
    dirt: { fastJacks: d.fastJacks, jacks: d.jacks, handImbalance: d.handImbalance, tightReleases: d.tightReleases, score: d.score },
  };
}

