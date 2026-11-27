/**
 * Bridge to MuG Diffusion (https://github.com/Keytoyze/Mug-Diffusion): a latent-diffusion charting
 * model for osu!mania 4K, controlled by star rating, map type / LN ratio and Etterna pattern types.
 * Code MIT; the model weights and the charts they create are NON-COMMERCIAL.
 *
 * Installed separately with scripts/setup-mug-diffusion.sh; generation runs scripts/mug/mug_generate.py
 * (headless, the same pipeline as MuG Diffusion's web UI) inside MuG Diffusion's own environment.
 */
import { cpuThreadEnv } from './mapperatorinator';
import { pickDir, readConfig } from '../config';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface MugInstall { dir: string; python: string; available: boolean; problem?: string }

export function defaultMugDir(): string {
  return pickDir(process.env.MUG_DIFFUSION_DIR, readConfig().mugDir, join(homedir(), '.local', 'share', 'maniamap', 'MugDiffusion'));
}

export function findMugInstall(dir = defaultMugDir()): MugInstall {
  const python = join(dir, '.venv', 'bin', 'python');
  const fix = 'Run: maniamap setup mug   (or set MUG_DIFFUSION_DIR)';
  if (!existsSync(join(dir, 'mug'))) return { dir, python, available: false, problem: `MuG Diffusion not found in ${dir}. ${fix}` };
  if (!existsSync(python)) return { dir, python, available: false, problem: `Python environment not found: ${python}. ${fix}` };
  if (!existsSync(join(dir, 'models', 'ckpt', 'model.ckpt')) || !existsSync(join(dir, 'models', 'ckpt', 'model.yaml'))) {
    return { dir, python, available: false, problem: `MuG Diffusion weights missing in ${join(dir, 'models', 'ckpt')}. ${fix}` };
  }
  return { dir, python, available: true };
}

export type MugPattern = 'chordjack' | 'stamina' | 'stream' | 'jumpstream' | 'handstream' | 'jackspeed' | 'technical';

export interface MugOptions {
  audioPath: string;
  /** file name written into the .osu (AudioFilename) */
  audioName?: string;
  /** osu! star rating (MuG's own difficulty scale) */
  stars: number;
  /** Etterna MSD instead of / in addition to stars */
  msd?: number;
  /** 0..1 share of long notes: < 0.1 rice, > 0.4 LN map, else hybrid */
  lnRatio?: number;
  patterns?: Partial<Record<MugPattern, 'more' | 'less'>>;
  rankStatus?: 'ranked' | 'loved' | 'graveyard';
  /** number of charts to sample (each is one diffusion sample) */
  count?: number;
  /** DDIM steps (web UI default 100; 50 is close and twice as fast) */
  steps?: number;
  /** classifier-free guidance: how strongly to follow the prompt (default 5) */
  cfg?: number;
  seed?: number;
  /** known timing: snap to it instead of estimating the BPM */
  bpm?: number;
  offset?: number;
  title?: string;
  artist?: string;
}

/** maniamap styles -> MuG prompt */
export function mugPatternsForStyle(style: string | undefined): MugOptions['patterns'] {
  switch (style) {
    case 'stream': return { stream: 'more' };
    case 'jumpstream': return { jumpstream: 'more' };
    case 'chordjack': return { chordjack: 'more' };
    case 'tech': return { technical: 'more' };
    default: return undefined;
  }
}

export function mugRequest(o: MugOptions, outDir: string): Record<string, unknown> {
  const ln = o.lnRatio ?? 0.05;
  return {
    audio: o.audioPath, audio_name: o.audioName, out_dir: outDir, title: o.title ?? 'Untitled', artist: o.artist ?? 'Unknown',
    sr: Math.max(1, Math.min(12, o.stars)), ...(o.msd !== undefined ? { ett: o.msd } : {}),
    rank_status: o.rankStatus ?? 'ranked',
    map_type: ln < 0.1 ? 'rc' : ln > 0.4 ? 'ln' : 'hb', ...(ln >= 0.1 ? { ln_ratio: ln } : {}),
    patterns: o.patterns ?? {}, count: o.count ?? 1, steps: o.steps ?? 50, cfg: o.cfg ?? 5, seed: o.seed ?? -1,
    rm_jacks_ms: 90, auto_snap: true, ...(o.bpm ? { bpm: o.bpm, offset: o.offset ?? 0 } : {}),
  };
}

export interface MugJob { child: ChildProcess; done: Promise<{ osuTexts: string[]; log: string[] }>; cancel(): void }

export function runMug(o: MugOptions, runner: string, onLog: (line: string) => void = () => {}, install = findMugInstall()): MugJob {
  if (!install.available) throw new Error(install.problem);
  if (!existsSync(o.audioPath)) throw new Error(`audio not found: ${o.audioPath}`);
  const work = mkdtempSync(join(tmpdir(), 'maniamap-mug-'));
  const outDir = join(work, 'out');
  const child = spawn(install.python, [runner, JSON.stringify(mugRequest(o, outDir))], {
    cwd: install.dir, env: { ...process.env, ...cpuThreadEnv(), PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log: string[] = [];
  const outputs: string[] = [];
  const take = (buf: Buffer) => {
    for (const raw of buf.toString().split(/[\r\n]+/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      log.push(line);
      if (log.length > 400) log.shift();
      const m = /^MUG-OUTPUT (.+\.osu)$/.exec(line);
      if (m) outputs.push(m[1]);
      onLog(line);
    }
  };
  child.stdout!.on('data', take);
  child.stderr!.on('data', take);
  let cancelled = false;
  const done = new Promise<{ osuTexts: string[]; log: string[] }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        if (cancelled) throw new Error('cancelled');
        if (code !== 0) throw new Error(`MuG Diffusion exited with code ${code}:\n${log.slice(-12).join('\n')}`);
        if (!outputs.length) throw new Error(`MuG Diffusion wrote no chart:\n${log.slice(-8).join('\n')}`);
        resolve({ osuTexts: outputs.map((p) => readFileSync(p, 'utf8')), log });
      } catch (e) { reject(e); } finally { rmSync(work, { recursive: true, force: true }); }
    });
  });
  return { child, done, cancel: () => { cancelled = true; child.kill('SIGTERM'); } };
}
