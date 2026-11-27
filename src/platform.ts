/** Supported systems. */
export type PlatformCheck = { ok: true } | { ok: false; reason: string };

export const LINUX_ONLY_MESSAGE = 'maniamap runs on Linux only. Windows (including WSL) and other systems are not supported.';

/** Is this a supported system? */
export function checkPlatform(platform: string, procVersion = '', env: Record<string, string | undefined> = {}): PlatformCheck {
  if (platform === 'win32' || platform === 'cygwin') return { ok: false, reason: `${LINUX_ONLY_MESSAGE} (found: Windows)` };
  if (platform !== 'linux') return { ok: false, reason: `${LINUX_ONLY_MESSAGE} (found: ${platform})` };
  if (/microsoft|wsl/i.test(procVersion) || env.WSL_DISTRO_NAME || env.WSL_INTEROP) return { ok: false, reason: `${LINUX_ONLY_MESSAGE} (found: WSL on Windows)` };
  return { ok: true };
}

/** the browser app: is the page opened on a supported system? */
export function checkBrowserPlatform(nav: { userAgent?: string; platform?: string; userAgentData?: { platform?: string } }): PlatformCheck {
  const p = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent ?? ''}`;
  if (/windows|win32|win64/i.test(p)) return { ok: false, reason: `${LINUX_ONLY_MESSAGE} (found: Windows)` };
  return { ok: true };
}

