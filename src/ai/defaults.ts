/**
 * Default AI setup per key count, chosen from held-out evaluations (scripts/bench/compare-ai.ts):
 * which Mapperatorinator model, whether to condition on a reference mapper, and which LoRA to
 * apply when it is installed. Anything set on the command line or in the UI wins.
 */
import type { AiModel } from './mapperatorinator';
import { MAPPER_DIFFICULTY_BOOST } from './mappers';

export interface AiDefault {
  model: AiModel;
  /** condition on the best-fitting reference mapper */
  mapper: 'auto' | 'none';
  /** LoRA name in the store, used when installed (`maniamap lora-list`) */
  lora?: string;
  /** osu! stars added to the model's difficulty input (the model maps easier than asked) */
  starBoost?: number;
  /** why: the evaluation behind this default */
  basis?: string;
}

const FALLBACK: AiDefault = {
  model: 'v32', mapper: 'auto',
  basis: '4K, 6 held-out songs: reference mapper skill-mix distance 0.50 -> 0.40 at equal rhythm F1',
};

export const AI_DEFAULTS: Record<number, AiDefault> = {
  // 7K, 6 held-out songs at 6.9-10.3 stars (none in the 7K LoRA's training data): plain V32 is best
  // (rhythm F1 0.89, skill-mix distance 0.08, 11 fast jacks); a reference mapper makes it worse
  // (0.83, 0.14, 30) and the mania-7k LoRA with a mapper does not recover that (0.88, 0.13, 21).
  // Around 3 stars the mapper helps the pattern mix (0.38 -> 0.34) but 7K is chosen for 6+ stars.
  // No starBoost: the raw bias is -0.06 stars at 6-10 stars.
  7: {
    model: 'v32', mapper: 'none',
    basis: '7K, 6 held-out songs at 6.9-10.3 stars: without a reference mapper rhythm F1 0.83 -> 0.89, skill-mix distance 0.14 -> 0.08, fast jacks 30 -> 11',
  },
};

export function aiDefaultsFor(keys: number): AiDefault {
  return AI_DEFAULTS[keys] ?? FALLBACK;
}

/** the default LoRA for these keys, if it is installed */
export function defaultLora(keys: number, installed: string[]): string | undefined {
  const l = aiDefaultsFor(keys).lora;
  return l && installed.includes(l) ? l : undefined;
}

/**
 * The difficulty to give the model for a target in osu! stars: with a reference mapper the model
 * aims lower, and some key counts need a measured calibration on top.
 */
export function modelStars(keys: number, officialStars: number, withMapper: boolean): number {
  return officialStars + (withMapper ? MAPPER_DIFFICULTY_BOOST : 0) + (aiDefaultsFor(keys).starBoost ?? 0);
}
