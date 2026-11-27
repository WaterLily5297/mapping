/**
 * Style descriptors understood by Mapperatorinator's osu!mania model (V32, gamemode=3).
 * They are osu! user tags; the strings were checked against the model's tokenizer.json
 * (note: the model spells "style/LN mixed" with a trailing space).
 */
export interface Descriptor { tag: string; group: string }

export const MANIA_DESCRIPTORS: Descriptor[] = [
  { tag: 'style/jumpstream', group: 'Rice' },
  { tag: 'style/handstream', group: 'Rice' },
  { tag: 'style/quadstream', group: 'Rice' },
  { tag: 'style/chordstream', group: 'Rice' },
  { tag: 'style/chordjack', group: 'Rice' },
  { tag: 'style/longjack', group: 'Rice' },
  { tag: 'style/mixed rice', group: 'Rice' },
  { tag: 'skillset/streams', group: 'Skillset' },
  { tag: 'skillset/speedjack', group: 'Skillset' },
  { tag: 'skillset/wristjack', group: 'Skillset' },
  { tag: 'skillset/tech', group: 'Skillset' },
  { tag: 'skillset/reading', group: 'Skillset' },
  { tag: 'streams/stamina', group: 'Streams' },
  { tag: 'streams/speed', group: 'Streams' },
  { tag: 'streams/bursts', group: 'Streams' },
  { tag: 'tech/complex snap', group: 'Tech' },
  { tag: 'style/LN coordination', group: 'LN' },
  { tag: 'style/LN release', group: 'LN' },
  { tag: 'style/LN density', group: 'LN' },
  { tag: 'gimmick/LN inverse', group: 'LN' },
  { tag: 'style/LN mixed', group: 'LN' },
  { tag: 'style/generic hybrid', group: 'Hybrid' },
  { tag: 'tech/technical hybrid', group: 'Hybrid' },
  { tag: 'sliders/low sv', group: 'SV' },
  { tag: 'sliders/high sv', group: 'SV' },
  { tag: 'sliders/complex sv', group: 'SV' },
  { tag: 'expression/simple', group: 'Expression' },
  { tag: 'expression/repetition', group: 'Expression' },
  { tag: 'expression/progression', group: 'Expression' },
  { tag: 'expression/high contrast', group: 'Expression' },
  { tag: 'style/tiebreaker', group: 'Other' },
  { tag: 'style/o2jam', group: 'Other' },
  { tag: 'style/dump', group: 'Other' },
];

const MODEL_SPELLING: Record<string, string> = { 'style/LN mixed': 'style/LN mixed ' };

/** Convert user-facing tags to the exact strings in the model vocabulary; unknown tags are rejected. */
export function toModelDescriptors(tags: string[]): string[] {
  const known = new Set(MANIA_DESCRIPTORS.map((d) => d.tag));
  for (const t of tags) {
    if (!known.has(t.trim())) throw new Error(`unknown style tag "${t}". Known: ${[...known].join(', ')}`);
  }
  return tags.map((t) => MODEL_SPELLING[t.trim()] ?? t.trim());
}
