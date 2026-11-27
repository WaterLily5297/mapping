/**
 * What maniamap needs, what is installed, and how to fix what is missing. Used by `maniamap doctor`
 * and by the app's setup panel (/api/doctor). Node only.
 */
import { existsSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { findAiInstall, listLoras } from './ai/mapperatorinator';
import { findMugInstall } from './ai/mug';

export type CheckState = 'ok' | 'missing' | 'optional' | 'warn';
export interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
  /** what to run or do to fix it */
  fix?: string;
  /** maniamap can do it: `maniamap setup <setup>` / the app's Set up button */
  setup?: 'ai' | 'mug';
}

const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
const out = (cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.status === 0 ? (r.stdout || r.stderr).trim() : ''; };

/** the Hugging Face cache folder holding downloaded models */
function hfHub(): string {
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
  if (process.env.HF_HOME) return join(process.env.HF_HOME, 'hub');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'huggingface', 'hub');
}
/** is the mania model (gamemode=3 weights) of a Mapperatorinator repo downloaded? */
export function aiModelDownloaded(repo = 'OliBomby/Mapperatorinator-v32'): boolean {
  const snaps = join(hfHub(), `models--${repo.replace('/', '--')}`, 'snapshots');
  try { return readdirSync(snaps).some((s) => existsSync(join(snaps, s, 'gamemode=3'))); } catch { return false; }
}

export function runChecks(): Check[] {
  const checks: Check[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ id: 'node', label: 'Node.js', state: nodeMajor >= 20 ? 'ok' : 'missing', detail: `v${process.versions.node}`, fix: nodeMajor >= 20 ? undefined : 'sudo apt install nodejs (version 20 or newer)' });
  const ff = has('ffmpeg');
  checks.push({ id: 'ffmpeg', label: 'ffmpeg (reads audio for the command line and the AI)', state: ff ? 'ok' : 'missing', detail: ff ? out('ffmpeg', ['-version']).split('\n')[0].replace(/ Copyright.*/, '') : 'not installed', fix: ff ? undefined : 'sudo apt install ffmpeg' });
  const git = has('git');
  checks.push({ id: 'git', label: 'git (downloads the AI engines)', state: git ? 'ok' : 'missing', detail: git ? out('git', ['--version']) : 'not installed', fix: git ? undefined : 'sudo apt install git' });
  const uvLocal = join(process.env.MANIAMAP_HOME ?? join(homedir(), '.local', 'share', 'maniamap'), 'bin', 'uv');
  const uv = has('uv') || existsSync(uvLocal);
  checks.push({ id: 'uv', label: 'uv (Python manager for the AI)', state: uv ? 'ok' : 'optional', detail: uv ? (has('uv') ? out('uv', ['--version']) : `${out(uvLocal, ['--version'])} (maniamap's own)`) : 'not installed: the AI setup downloads it' });
  const ai = findAiInstall();
  const model = aiModelDownloaded();
  checks.push({
    id: 'ai', label: 'AI mapper (Mapperatorinator V32, best quality)', setup: 'ai',
    state: ai.available && model ? 'ok' : 'missing',
    detail: ai.available ? (model ? `installed in ${ai.dir}` : `installed in ${ai.dir}, the mania model is not downloaded yet`) : 'not installed: maps use the quick rules engine (much lower quality)',
    fix: ai.available && model ? undefined : 'maniamap setup ai   (about 2 GB, 10-30 minutes)',
  });
  const gpu = has('nvidia-smi') ? out('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']).split('\n')[0] : '';
  checks.push({ id: 'gpu', label: 'NVIDIA GPU (much faster AI)', state: gpu ? 'ok' : 'optional', detail: gpu || 'none: the AI runs on the CPU (a few minutes per minute of song)' });
  const mug = findMugInstall();
  checks.push({ id: 'mug', label: 'MuG Diffusion (optional 4K engine, non-commercial weights)', setup: 'mug', state: mug.available ? 'ok' : 'optional', detail: mug.available ? `installed in ${mug.dir}` : 'not installed', fix: mug.available ? undefined : 'maniamap setup mug   (about 3 GB)' });
  const loras = listLoras();
  checks.push({ id: 'lora', label: 'AI style add-ons (LoRA)', state: loras.length ? 'ok' : 'optional', detail: loras.length ? loras.map((l) => l.name).join(', ') : 'none (train one with maniamap lora-train, or import one)' });
  try {
    const st = statfsSync(homedir());
    const freeGb = (st.bavail * st.bsize) / 1e9;
    checks.push({ id: 'disk', label: 'Free disk space', state: freeGb >= 6 || ai.available ? 'ok' : 'warn', detail: `${freeGb.toFixed(1)} GB free in your home folder`, fix: freeGb >= 6 || ai.available ? undefined : 'the AI setup needs about 2 GB (5 GB with an NVIDIA GPU)' });
  } catch { /* statfs not available */ }
  const binOnPath = (process.env.PATH ?? '').split(':').includes(join(homedir(), '.local', 'bin'));
  checks.push({ id: 'path', label: 'maniamap command on PATH', state: binOnPath ? 'ok' : 'warn', detail: binOnPath ? '~/.local/bin is on PATH' : '~/.local/bin is not on PATH', fix: binOnPath ? undefined : 'log out and in again, or add  export PATH="$HOME/.local/bin:$PATH"  to ~/.bashrc' });
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const mark: Record<CheckState, string> = { ok: '✓', missing: '✗', optional: '·', warn: '!' };
  const lines = checks.map((c) => `${mark[c.state]} ${c.label}\n    ${c.detail}${c.fix ? `\n    → ${c.fix}` : ''}`);
  const missing = checks.filter((c) => c.state === 'missing');
  lines.push('', missing.length ? `${missing.length} thing${missing.length === 1 ? '' : 's'} to fix (✗). Optional items (·) add features.` : 'Everything maniamap needs is installed.');
  return lines.join('\n');
}
