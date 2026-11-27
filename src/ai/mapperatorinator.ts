/**
 * Bridge to Mapperatorinator (https://github.com/OliBomby/Mapperatorinator, MIT) — an AI
 * that generates osu! beatmaps from audio, with an osu!mania model (1K..18K).
 *
 * maniamap does not ship the model: install it once with scripts/setup-mapperatorinator.sh
 * (Python 3.10 venv + PyTorch; the ~0.9 GB mania weights download from Hugging Face on first use).
 * Node only (used by the CLI and by the `maniamap editor` server).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, cpus } from 'node:os';
import { extname, join } from 'node:path';
import { toModelDescriptors } from './descriptors';
import { pickDir, readConfig } from '../config';

export interface AiInstall { dir: string; python: string; available: boolean; problem?: string }

export function defaultAiDir(): string {
  return pickDir(process.env.MAPPERATORINATOR_DIR, readConfig().aiDir, join(homedir(), '.local', 'share', 'maniamap', 'Mapperatorinator'));
}

export function findAiInstall(dir = defaultAiDir(), python?: string): AiInstall {
  const py = python || process.env.MAPPERATORINATOR_PYTHON || join(dir, '.venv', 'bin', 'python');
  if (!existsSync(join(dir, 'inference.py'))) {
    return { dir, python: py, available: false, problem: `Mapperatorinator not found in ${dir}. Run: maniamap setup ai   (or set MAPPERATORINATOR_DIR)` };
  }
  if (!existsSync(py)) return { dir, python: py, available: false, problem: `Python environment not found: ${py}. Run: maniamap setup ai` };
  if (!setupComplete(dir, py)) return { dir, python: py, available: false, problem: 'the AI setup did not finish (it was stopped or failed). Set it up again: it continues where it stopped.' };
  return { dir, python: py, available: true };
}

/** written by scripts/setup-mapperatorinator.sh as its last step */
export const SETUP_MARKER = '.maniamap-setup-complete';
const verified = new Map<string, boolean>();
/**
 * Did the setup run to the end? The setup creates the Python environment before installing
 * PyTorch into it, so an environment alone can be a stopped setup. Installs from before the
 * marker existed are checked once by importing the packages (and then get the marker).
 */
export function setupComplete(dir: string, python: string): boolean {
  if (existsSync(join(dir, SETUP_MARKER))) return true;
  if (process.env.MAPPERATORINATOR_PYTHON) return true; // a Python chosen by hand: trust it
  if (verified.has(dir)) return verified.get(dir)!;
  const r = spawnSync(python, ['-c', 'import torch, transformers, hydra'], { timeout: 60000, stdio: 'ignore' });
  const ok = r.status === 0;
  verified.set(dir, ok);
  if (ok) { try { writeFileSync(join(dir, SETUP_MARKER), `${new Date().toISOString()}\n`); } catch { /* read-only */ } }
  return ok;
}

/** the line that says why the AI stopped, and what to do about it */
export function explainAiFailure(log: string[]): string {
  const lines = log.map((l) => l.trim()).filter(Boolean);
  const reason = [...lines].reverse().find((l) => /(Error|Exception)\b|No module named|Killed|out of memory|CUDA/i.test(l) && !/^Set the environment variable HYDRA_FULL_ERROR/.test(l)) ?? lines[lines.length - 1] ?? 'no output';
  if (/No module named|ModuleNotFoundError|ImportError/i.test(reason)) return `${reason} — the AI setup is incomplete: click Set up the AI (or run: maniamap setup ai) again.`;
  if (/out of memory|Killed|MemoryError/i.test(reason)) return `${reason} — not enough memory: close other programs, or pick the V32-mini model.`;
  return reason;
}

export interface AiOptions {
  audioPath: string;
  keys: number;
  /** target star rating (0..12) */
  stars?: number;
  /** 0..1 share of hold notes */
  holdNoteRatio?: number;
  /** 0..1 amount of scroll-speed (SV) changes; 0 = none */
  scrollSpeedRatio?: number;
  /** osu! user tags for style, e.g. ['style/jumpstream'] */
  descriptors?: string[];
  negativeDescriptors?: string[];
  /** upload year to imitate (2007..2024); helps consistency */
  year?: number;
  /** classifier-free guidance; > 1 follows the descriptors more strongly */
  cfgScale?: number;
  seed?: number;
  /** an .osu whose timing should be reused (faster and more accurate than generating timing) */
  timingOsuText?: string;
  /** generate only this part of the song (ms) */
  startTime?: number;
  endTime?: number;
  /** cpu / cuda / mps / auto */
  device?: string;
  title?: string;
  artist?: string;
  /** LoRA adapter folder (from `maniamap lora-train`) to apply a learned style */
  loraPath?: string;
  /** osu! user id of a mapper the model knows: generate in that mapper's style */
  mapperId?: number;
  /** which Mapperatorinator model: V32 (default, best) or V32-mini (4x smaller, faster on a CPU) */
  model?: AiModel;
  /**
   * Fraction of each 16.4 s window filled with the notes of the previous one (Mapperatorinator's
   * inference default is 0.5, the model was trained with 0.2). The decoder has 2560 tokens per
   * window: with 0.5 on dense charts the re-read notes use up the budget and the window ends early,
   * leaving seconds without notes. maniamap uses AI_WINDOW unless this is set.
   */
  lookback?: number;
  /** fraction of each window at its end that is not kept (inference default 0.4); the window
   *  advances by (1 - lookback - lookahead) of 16.4 s */
  lookahead?: number;
}

export type AiModel = 'v32' | 'v32-mini';

/**
 * Inference window used by maniamap: re-read 3.3 s of earlier notes (as in training) and keep the
 * next 1.6 s, the same step as Mapperatorinator's default (lookback 0.5, lookahead 0.4) but with
 * far fewer re-read tokens. On 6 held-out 7K songs at 6.9-10.3 stars this took empty measures
 * 6.5% -> 0% (the densest song: 11 of 39 -> 0) and rhythm F1 0.89 -> 0.92; around 3 stars F1 is
 * about the same (0.933 -> 0.925) and it is faster.
 */
export const AI_WINDOW = { lookback: 0.2, lookahead: 0.7 };
export const AI_MODELS: Record<AiModel, { label: string; repo: string }> = {
  v32: { label: 'V32 (best quality)', repo: 'OliBomby/Mapperatorinator-v32' },
  'v32-mini': { label: 'V32-mini (4x smaller, faster)', repo: 'OliBomby/Mapperatorinator-v32-mini' },
};

export interface AiResult { osuText: string; log: string[] }

/** Hydra string quoting: wrap in single quotes, escape backslashes and single quotes. */
export function hq(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function buildArgs(o: AiOptions, outDir: string, refPath?: string): string[] {
  if (!(o.keys >= 1 && o.keys <= 18)) throw new Error('keys must be 1..18');
  const a = [
    'inference.py',
    ...(o.model === 'v32-mini' ? ['--config-name=v32-mini'] : []),
    `audio_path=${hq(o.audioPath)}`,
    `output_path=${hq(outDir)}`,
    'gamemode=3',
    `keycount=${o.keys}`,
    `difficulty=${o.stars ?? 3.5}`,
    `hold_note_ratio=${o.holdNoteRatio ?? 0.1}`,
    `scroll_speed_ratio=${o.scrollSpeedRatio ?? 0}`,
    `year=${o.year ?? 2023}`,
    `cfg_scale=${o.cfgScale ?? 1}`,
    `device=${o.device ?? 'auto'}`,
    'export_osz=false',
    'hitsounded=false',
  ];
  a.push(`lookback=${o.lookback ?? AI_WINDOW.lookback}`, `lookahead=${o.lookahead ?? AI_WINDOW.lookahead}`);
  if (o.seed !== undefined) a.push(`seed=${o.seed}`);
  if (o.descriptors?.length) a.push(`descriptors=[${toModelDescriptors(o.descriptors).map(hq).join(',')}]`);
  if (o.negativeDescriptors?.length) a.push(`negative_descriptors=[${toModelDescriptors(o.negativeDescriptors).map(hq).join(',')}]`);
  if (refPath) a.push(`beatmap_path=${hq(refPath)}`, 'in_context=[TIMING]', 'output_type=[MAP]');
  if (o.startTime !== undefined) a.push(`start_time=${Math.round(o.startTime)}`);
  if (o.endTime !== undefined) a.push(`end_time=${Math.round(o.endTime)}`);
  if (o.loraPath) a.push(`lora_path=${hq(o.loraPath)}`);
  if (o.mapperId) a.push(`mapper_id=${Math.round(o.mapperId)}`);
  if (o.title) a.push(`title=${hq(o.title)}`);
  if (o.artist) a.push(`artist=${hq(o.artist)}`);
  return a;
}

// ---------------------------------------------------------------- LoRA store

export function loraStoreDir(): string {
  return pickDir(process.env.MANIAMAP_LORA_DIR, readConfig().loraDir, join(homedir(), '.local', 'share', 'maniamap', 'loras'));
}

export interface LoraInfo { name: string; path: string; info: Record<string, unknown> }

/** LoRAs trained by `maniamap lora-train` (folders with adapter_config.json). */
export function listLoras(dir = loraStoreDir()): LoraInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith('.') && existsSync(join(dir, n, 'adapter_config.json')))
    .map((name) => {
      const p = join(dir, name);
      let info: Record<string, unknown> = {};
      try { info = JSON.parse(readFileSync(join(p, 'maniamap.json'), 'utf8')); } catch { /* trained elsewhere */ }
      return { name, path: p, info };
    });
}

/** A LoRA by name (from the store) or by folder path. */
export function resolveLora(nameOrPath: string): string {
  if (existsSync(join(nameOrPath, 'adapter_config.json'))) return nameOrPath;
  const p = join(loraStoreDir(), nameOrPath);
  if (existsSync(join(p, 'adapter_config.json'))) return p;
  const known = listLoras().map((l) => l.name);
  throw new Error(`LoRA "${nameOrPath}" not found${known.length ? ` (available: ${known.join(', ')})` : ' (train one with: maniamap lora-train)'}`);
}

/**
 * Thread settings for the AI on a CPU: one core is left free. PyTorch's worker threads wait for
 * each other; when another program (the browser showing the app) keeps one core busy, using all
 * cores makes every step wait for the busy one: with one core busy, 15 s of audio took 392 s with
 * all 4 threads and 89 s with 3. Variables the user set are kept.
 */
export function cpuThreadEnv(cores = cpus().length, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const n = String(Math.max(1, cores - 1));
  const out: Record<string, string> = {};
  for (const k of ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS']) if (!env[k]) out[k] = n;
  return out;
}

/** scripts/ folder shipped with maniamap (works from dist/cli.mjs and from src/ via tsx). */
export function scriptsDir(here: string): string {
  for (const c of [join(here, '..', 'scripts'), join(here, '..', '..', 'scripts')]) {
    if (existsSync(join(c, 'lora', 'train_lora.py')) && statSync(c).isDirectory()) return c;
  }
  throw new Error('maniamap scripts/ folder not found next to the program');
}

export interface AiJob { child: ChildProcess; done: Promise<AiResult>; cancel(): void }

/** Start Mapperatorinator. `onLog` receives every output line (progress bars included). */
export function runMapperatorinator(o: AiOptions, onLog: (line: string) => void = () => {}, install = findAiInstall()): AiJob {
  if (!install.available) throw new Error(install.problem);
  if (!existsSync(o.audioPath)) throw new Error(`audio not found: ${o.audioPath}`);
  const work = mkdtempSync(join(tmpdir(), 'maniamap-ai-'));
  const outDir = join(work, 'out');
  // Mapperatorinator reads only these formats; convert anything else (e.g. .opus from data-fetch)
  if (!['.flac', '.m4a', '.wav', '.mp3', '.ogg'].includes(extname(o.audioPath).toLowerCase())) {
    const flac = join(work, 'audio.flac');
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', o.audioPath, flac]);
    if (r.status !== 0 || !existsSync(flac)) throw new Error(`could not convert ${o.audioPath} for the AI (is ffmpeg installed?)`);
    o = { ...o, audioPath: flac };
  }
  let refPath: string | undefined;
  if (o.timingOsuText) {
    refPath = join(work, 'reference.osu');
    writeFileSync(refPath, o.timingOsuText);
  }
  const args = buildArgs(o, outDir, refPath);
  const log: string[] = [];
  const child = spawn(install.python, args, {
    cwd: install.dir,
    env: { ...process.env, ...cpuThreadEnv(), PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_TELEMETRY: '1', WANDB_MODE: 'disabled', TOKENIZERS_PARALLELISM: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let saved = '';
  const take = (buf: Buffer) => {
    for (const raw of buf.toString().split(/[\r\n]+/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      log.push(line);
      if (log.length > 400) log.shift();
      const m = /Generated beatmap saved to (.+\.osu)/.exec(line);
      if (m) saved = m[1].trim();
      onLog(line);
    }
  };
  child.stdout!.on('data', take);
  child.stderr!.on('data', take);
  let cancelled = false;
  const done = new Promise<AiResult>((resolve, reject) => {
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      try {
        if (cancelled) throw new Error('cancelled');
        if (code !== 0) throw new Error(`the AI stopped: ${explainAiFailure(log)}\n\n${log.slice(-15).join('\n')}`);
        const file = saved && existsSync(saved) ? saved
          : existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.osu')).map((f) => join(outDir, f))[0] : undefined;
        if (!file) throw new Error(`Mapperatorinator finished but no .osu was written:\n${log.slice(-10).join('\n')}`);
        resolve({ osuText: readFileSync(file, 'utf8'), log });
      } catch (e) {
        reject(e);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  });
  return { child, done, cancel: () => { cancelled = true; child.kill('SIGTERM'); } };
}
