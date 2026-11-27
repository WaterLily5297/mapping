/**
 * maniamap's settings file (~/.config/maniamap/config.json): where the AI engines and LoRAs live.
 * Environment variables win; the file makes a folder chosen once (e.g. MAPPERATORINATOR_DIR in a
 * terminal) also work when maniamap starts from the applications menu, which does not read the
 * shell's ~/.bashrc. Node only.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface Config { aiDir?: string; mugDir?: string; loraDir?: string }

export function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'maniamap', 'config.json');
}
export function readConfig(): Config {
  try { return JSON.parse(readFileSync(configPath(), 'utf8')) as Config; } catch { return {}; }
}
export function saveConfig(patch: Config): void {
  const next = { ...readConfig(), ...patch };
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n');
}
/** a folder from the environment, else from the settings file (if it still exists), else the default */
export function pickDir(envValue: string | undefined, saved: string | undefined, fallback: string): string {
  if (envValue) return envValue;
  if (saved && existsSync(saved)) return saved;
  return fallback;
}
