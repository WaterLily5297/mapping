import { describe, it, expect } from 'vitest';
import { AI_DEFAULTS, aiDefaultsFor, defaultLora, modelStars } from '../src/ai/defaults';
import { MAPPER_DIFFICULTY_BOOST } from '../src/ai/mappers';

describe('AI defaults per key count', () => {
  it('falls back to V32 with a reference mapper and no LoRA', () => {
    const d = aiDefaultsFor(13);
    expect(d.model).toBe('v32');
    expect(d.mapper).toBe('auto');
    expect(d.lora).toBeUndefined();
  });

  it('every per-key default says what evaluation it comes from', () => {
    for (const [k, d] of Object.entries(AI_DEFAULTS)) {
      expect(Number(k)).toBeGreaterThan(0);
      expect(d.basis, `${k}K basis`).toBeTruthy();
    }
  });

  it('uses the default LoRA only when it is installed', () => {
    const withLora = Object.entries(AI_DEFAULTS).find(([, d]) => d.lora);
    expect(defaultLora(13, ['anything'])).toBeUndefined();
    if (withLora) {
      const [k, d] = withLora;
      expect(defaultLora(Number(k), [d.lora!])).toBe(d.lora);
      expect(defaultLora(Number(k), [])).toBeUndefined();
    }
  });

  it('adds the mapper boost and the per-key calibration to the model difficulty', () => {
    expect(modelStars(13, 5, false)).toBeCloseTo(5);
    expect(modelStars(13, 5, true)).toBeCloseTo(5 + MAPPER_DIFFICULTY_BOOST);
    for (const [k, d] of Object.entries(AI_DEFAULTS)) {
      expect(modelStars(Number(k), 5, false)).toBeCloseTo(5 + (d.starBoost ?? 0));
    }
  });
});
