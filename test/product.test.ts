import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VERSION, newerVersion } from '../src/version';
import { runChecks, formatChecks } from '../src/doctor';

describe('product basics', () => {
  it('the version in the program is the package version', () => {
    expect(VERSION).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
  });

  it('compares versions for updates', () => {
    expect(newerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(newerVersion('v1.10.0', '1.9.9')).toBe(true);
    expect(newerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(newerVersion('0.9.0', '1.0.0')).toBe(false);
  });

  it('the release package holds what an install needs', () => {
    const sh = readFileSync('scripts/release.sh', 'utf8');
    for (const p of ['dist', 'assets', 'install.sh', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'scripts/lib', 'scripts/lora', 'scripts/mug', 'setup-mapperatorinator.sh']) expect(sh).toContain(p);
    expect(readFileSync('install.sh', 'utf8')).toContain('prebuilt');
    expect(readFileSync('CHANGELOG.md', 'utf8')).toContain(`## ${VERSION}`);
  });

  it('doctor checks the essentials and says how to fix what is missing', () => {
    const checks = runChecks();
    for (const id of ['node', 'ffmpeg', 'git', 'uv', 'ai', 'gpu', 'mug', 'lora', 'path']) expect(checks.map((c) => c.id)).toContain(id);
    for (const c of checks) if (c.state === 'missing') expect(c.fix, c.id).toBeTruthy();
    expect(formatChecks(checks)).toMatch(/installed|to fix/);
  });

  it('on a fresh account the AI shows as missing, with the setup command', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'maniamap-fresh-'));
    const saved = { ...process.env };
    process.env.MAPPERATORINATOR_DIR = join(fresh, 'none');
    process.env.MUG_DIFFUSION_DIR = join(fresh, 'none2');
    process.env.MANIAMAP_LORA_DIR = join(fresh, 'loras');
    try {
      const ai = runChecks().find((c) => c.id === 'ai')!;
      expect(ai.state).toBe('missing');
      expect(ai.fix).toContain('maniamap setup ai');
      expect(ai.setup).toBe('ai');
    } finally { process.env = saved; }
  });
});
