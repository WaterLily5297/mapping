import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig, saveConfig, pickDir } from '../src/config';

describe('settings file', () => {
  it('remembers engine folders, and the environment still wins', () => {
    const home = mkdtempSync(join(tmpdir(), 'maniamap-cfg-'));
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(home, 'config');
    try {
      expect(readConfig()).toEqual({});
      const ai = join(home, 'ai'); mkdirSync(ai);
      saveConfig({ aiDir: ai });
      saveConfig({ mugDir: '/elsewhere' });
      expect(readConfig()).toEqual({ aiDir: ai, mugDir: '/elsewhere' });
      expect(pickDir(undefined, readConfig().aiDir, '/default')).toBe(ai);
      expect(pickDir('/from-env', readConfig().aiDir, '/default')).toBe('/from-env');
      // a remembered folder that no longer exists falls back to the default
      expect(pickDir(undefined, join(home, 'gone'), '/default')).toBe('/default');
    } finally { if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved; }
  });
});
