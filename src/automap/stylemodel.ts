/**
 * Learned auto-style models (multinomial logistic regression), trained by
 * scripts/bench/train-style-model.ts.
 *
 * STYLE_MODEL: 40,634 measures of ranked maps (held-out accuracy 0.578). Used for 6K, 7K and other
 * key counts.
 * STYLE_MODELS_BY_KEYS[4]: retrained on 205,156 measures from ~3,000 songs (split by set id):
 * held-out accuracy on 4K measures 0.441 -> 0.501 (4-6 stars) and 0.408 -> 0.453 (6-8 stars); in
 * the generator benchmark (auto style, held-out songs) 4K pattern-mix distance 0.488 -> 0.452 and
 * 0.560 -> 0.523 at 6+ stars. For 6K and 7K it was no better (7K 0.306 -> 0.309), so they keep
 * STYLE_MODEL.
 */
import type { StyleModel } from './stylefeatures';

export const STYLE_MODEL: StyleModel = {"classes":["balanced","stream","jumpstream","chordjack"],"weights":[[-0.2349,0.0682,0.1986,-0.4033,0.0728,-0.0306,-0.0055,0.0503,-0.0384,-0.1864,0.5422,-0.9289,0.3211,-0.4608,-0.3923,-1.4108],[0.122,0.1149,-0.1799,-0.2326,0.0566,0.0029,0.0071,-0.0016,-0.0061,-0.0208,-0.1478,0.2619,-0.2925,-0.1182,-0.1569,0.14],[0.148,-0.0065,-0.1218,0.3572,-0.0791,-0.0028,-0.0451,0.0631,-0.0076,0.0707,-0.0355,0.1034,0.2855,0.1513,0.2537,0.914],[-0.0351,-0.1767,0.1031,0.2788,-0.0503,0.0305,0.0436,-0.1118,0.052,0.1365,-0.3589,0.5635,-0.3141,0.4277,0.2955,0.3568]],"mean":[0.6196,0.157,0.2505,0.0671,0.8217,0.0359,0.2846,0.3282,0.3872,0.9544,0.0798,1.3267,-0.2478,0.8077,0.3754,0],"std":[0.4282,0.282,0.1251,0.2472,0.1155,0.065,0.0672,0.0557,0.0635,0.0364,0.2812,0.4957,0.2128,0.6441,0.1706,0]};

export const STYLE_MODELS_BY_KEYS: Record<number, StyleModel> = { 4: {"classes":["balanced","stream","jumpstream","chordjack"],"weights":[[-0.1412,0.0126,0.2392,-0.3865,-0.046,0.0352,-0.0469,-0.0218,0.0673,-0.1602,0.5079,-0.4557,0.3225,-0.5026,-0.1062,-1.3221],[0.1761,-0.035,-0.186,-0.2188,0.0396,0.0648,-0.0452,0.0574,-0.006,-0.0855,-0.1543,0.2411,-0.415,-0.05,0.0137,0.0796],[0.1186,0.0409,-0.1034,0.2782,0.0426,-0.0375,0.0418,-0.0077,-0.0356,0.1448,-0.0403,0.0689,0.2968,0.1999,0.0149,0.8712],[-0.1536,-0.0185,0.0502,0.3271,-0.0362,-0.0625,0.0502,-0.028,-0.0258,0.1009,-0.3132,0.1457,-0.2043,0.3527,0.0776,0.3714]],"mean":[0.6637,0.1795,0.255,0.0713,0.8073,0.0398,0.282,0.3379,0.3801,0.9546,0.0158,1.1814,-0.2928,0.773,0.3335,0],"std":[0.4435,0.3054,0.1262,0.2539,0.1227,0.0766,0.0676,0.0601,0.0665,0.0362,0.2559,0.299,0.1957,0.5556,0.1188,0]} };

/** the style model for a key count (same classes in the same order as STYLE_MODEL) */
export function styleModelFor(keys: number): StyleModel {
  return STYLE_MODELS_BY_KEYS[keys] ?? STYLE_MODEL;
}
