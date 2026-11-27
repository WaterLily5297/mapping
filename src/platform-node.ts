/** The system check with this machine's values (Node only; cached). */
import { readFileSync } from 'node:fs';
import { checkPlatform, type PlatformCheck } from './platform';

let cached: PlatformCheck | null = null;
export function checkThisSystem(): PlatformCheck {
  if (cached) return cached;
  let procVersion = '';
  try { procVersion = readFileSync('/proc/version', 'utf8'); } catch { /* not Linux */ }
  cached = checkPlatform(process.platform, procVersion, process.env);
  return cached;
}
