import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkPlatform, checkBrowserPlatform } from '../src/platform';

describe('supported systems', () => {
  it('accepts Linux', () => {
    expect(checkPlatform('linux', 'Linux version 6.12.0-amd64 (debian-kernel@lists.debian.org)', {})).toEqual({ ok: true });
  });
  it('refuses unsupported systems', () => {
    for (const p of ['win32', 'cygwin', 'darwin', 'freebsd']) expect(checkPlatform(p).ok, p).toBe(false);
    expect(checkPlatform('linux', 'Linux version 5.15.153.1-microsoft-standard-WSL2', {}).ok).toBe(false);
    expect(checkPlatform('linux', '', { WSL_DISTRO_NAME: 'Debian' }).ok).toBe(false);
    const w = checkPlatform('win32');
    expect(!w.ok && w.reason).toMatch(/Linux only.*Windows/);
  });
  it('the browser app checks the system', () => {
    expect(checkBrowserPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/140.0', platform: 'Win32' }).ok).toBe(false);
    expect(checkBrowserPlatform({ userAgentData: { platform: 'Windows' } }).ok).toBe(false);
    expect(checkBrowserPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Firefox/140.0', platform: 'Linux x86_64' }).ok).toBe(true);
  });
  it('this Linux system passes the real check', async () => {
    const { checkThisSystem } = await import('../src/platform-node');
    expect(checkThisSystem().ok).toBe(true);
  });
  it('every entry point checks it', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    // three independent checks: start-up, server start, every API request
    // three independent server/CLI checks
    expect(cli.match(/checkThisSystem\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(readFileSync('index.html', 'utf8')).toContain('/src/ui/boot.ts');
    for (const f of ['install.sh', 'scripts/setup-mapperatorinator.sh', 'scripts/setup-mug-diffusion.sh', 'scripts/release.sh']) expect(readFileSync(f, 'utf8'), f).toContain('linux-only.sh');
    expect(JSON.parse(readFileSync('package.json', 'utf8')).os).toEqual(['linux']);
  });
});
