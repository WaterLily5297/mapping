/**
 * maniamap CLI — batch tools + auto-mapper for osu!mania (1K..18K).
 * Audio decoding uses ffmpeg (Debian: `sudo apt install ffmpeg`).
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync, mkdirSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, get as httpGet } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { parseOsu, writeOsu, getKeys, osuFileName, type Beatmap } from './core/beatmap';
import * as T from './tools/transforms';
import { classifyPatterns, PATTERN_INFO, summarize, describeTags, type PatternType } from './analysis/patterns';
import { generateFromAnalysis, resolveDirection, loudnessForMap, type Difficulty, STYLES, type StyleChoice } from './automap/generate';
import { generateForStars } from './automap/target';
import { starRating } from './analysis/difficulty';
import { fitDifficulty, rebirthToOfficial, officialToRebirth } from './tools/difficultyfit';
import { analyze, analyzeStereo, estimateTempo, stereoWidth } from './automap/analysis';
import { detectTiming, toTimingPoints } from './automap/tempomap';
import { createBeatmap } from './core/beatmap';
import { findAiInstall, runMapperatorinator, listLoras, resolveLora, loraStoreDir, scriptsDir, type AiOptions, type AiJob } from './ai/mapperatorinator';
import { buildDataset } from './lora/dataset';
import { fetchManiaData, SHARDS, type Variant } from './data/fetch';
import { zipDataset, makeNotebook, importLora } from './lora/notebook';
import { cpus, totalmem } from 'node:os';
import { postprocessAiMap } from './ai/postprocess';
import { MANIA_DESCRIPTORS } from './ai/descriptors';
import { MAPPERS, referenceMappers, mapperName } from './ai/mappers';
import { aiDefaultsFor, defaultLora, modelStars } from './ai/defaults';
import { VERSION, newerVersion } from './version';
import { checkThisSystem } from './platform-node';
import { runChecks, formatChecks } from './doctor';
import { saveConfig } from './config';
import { defaultAiDir } from './ai/mapperatorinator';
import { defaultMugDir } from './ai/mug';
import { findMugInstall, runMug, mugPatternsForStyle, type MugOptions, type MugJob } from './ai/mug';

const HELP = `maniamap ${VERSION} — osu!mania mapping tools for any key count (1K-18K)

usage: maniamap <command> [args] [options]

start here:
  editor   [--port 5173] [--no-open]       start the app (local web app) and open it in the browser
  doctor                                    check what is installed and how to fix what is missing
  setup    ai|mug [--cpu]                   install the AI mapper (best quality) or MuG Diffusion
  update   [--check]                        update maniamap (git checkout: pull and rebuild;
                                    release package: download the latest release)
  version                                   print the version

map tools (input: .osu file, output: -o FILE, default "<input>.<command>.osu"):
  info     <map.osu>                       stats + star rating + problems (unsnapped, overlaps...)
  sr       <map.osu|.osz> [--rate 1.2] [--json]
                                           star rating (Star Rating Rebirth, any key count) with
                                           the osu! estimate and a difficulty graph over time
  adjust   <map.osu> --stars X [--tolerance 0.1] [--allow-jacks] [--seed S]
           [--audio FILE | --no-contrast]  contrast-aware with the song's audio (default: the
                                    map's own audio file next to it, when found)
                                           reach a target star rating by cleanly removing or adding
                                           notes (keeps the source's cleanliness)
  patterns <map.osu|.osz> [--json] [--min-rows N]   classify patterns (stream, jumpstream, jack, trill...)
  convert  <map.osu> --keys N [--fill 0..1] [--spread-jacks] [--segment 4] [--seed S]
                                           clean key conversion 1K..18K (no new fast jacks,
                                           shapes kept, hands balanced; prints a dirt check)
  ln       <map.osu> [--preset light|hybrid|full|inverse] [--short R,L] [--long R,L]
           [--threshold 1] [--align 8] [--release-gap 0.25] [--min 0.25] [--random 0.2] [--seed S]
                                           clean LN conversion (grid releases, safe gaps)
  mirror   <map.osu>
  shuffle  <map.osu> [--mode permute|random] [--seed S]
  fullln   <map.osu> [--gap 0.25] [--max-beats B]   notes -> LNs (gap in beats)
  inverse  <map.osu> [--gap 0.125]
  noln     <map.osu>                       LNs -> normal notes
  quantize <map.osu> [--divisor 4]         snap notes to 1/divisor
  fix      <map.osu>                       remove stacked / overlapping notes
  rate     <map.osu> --rate 1.2            rate change (also re-encodes audio with ffmpeg if found)

auto-mapper:
  automap  <song.mp3|ogg|wav> --keys N [--stars X | --difficulty easy|normal|hard|insane|expert]
           [--engine ai|mug|rules]  default: the AI model when installed (with --mapper auto), else rules;
                                mug = MuG Diffusion (4K only)
           [--style auto|balanced|stream|jumpstream|chordjack|tech|ln]   (auto: learned, per section)
           [--timing map.osu]  use that map's timing (all red lines: songs with tempo changes)
           --stars X: set the difficulty first; the generator searches its settings until the
           chart has X stars (Star Rating Rebirth) [--tolerance 0.1]
           [--bpm 180 --offset 123] [--divisor 4] [--density 0..1] [--ln 0..1]
           [--max-chord N] [--pitch 0..1] [--seed S]
           [--direction auto|stereo|pitch]  lanes follow the stereo position of the sound or its
                                    pitch (auto: stereo for clearly panned mixes); quick rules only
           [--title T --artist A --creator C]
           [-o out.osz | out.osu]       (.osz bundles the audio, ready to import)

AI mapper (Mapperatorinator; set it up with: maniamap setup ai, or in the app):
  ai       <song.mp3> --keys N [--stars 3.5] [--fit] [--ln 0..1] [--sv 0..1]
           --stars: target in maniamap stars (Rebirth), converted to the model's osu! scale
           (or --model-stars X to give the osu! value directly); --fit adjusts the result
           to the target afterwards
           [--tags style/jumpstream,skillset/speedjack] [--avoid tags] [--cfg 1.5]
           [--year 2023] [--seed S] [--start ms --end ms] [--device cpu|cuda|auto]
           [--timing map.osu | --ai-timing]   (default: maniamap detects the BPM, much faster)
           [--lora NAME] [-o out.osz | out.osu] [--ai-dir DIR]
           [--model v32|mini]       V32 (default) or V32-mini (4x smaller, faster on a CPU)
           [--mapper auto|NAME|ID]  generate in the style of a mapper the model knows (auto: the
                                    best fit for the keys and stars among ranked mania mappers)
           [--lookback 0.2 --lookahead 0.7]  inference window (Mapperatorinator's own default,
                                    0.5 / 0.4, leaves seconds without notes on dense charts)
  ai-mappers [--keys N --stars X]   reference mappers the AI knows (for --mapper)

MuG Diffusion (osu!mania 4K; set it up with: maniamap setup mug;
weights and generated charts are non-commercial):
  mug      <song.mp3> [--stars 3.5] [--style stream|jumpstream|chordjack|tech|ln] [--ln 0..1]
           [--steps 50] [--cfg 5] [--seed S] [--timing map.osu] [--no-fit] [-o out.osz]
  mug-status                                is MuG Diffusion installed?
  ai-status                                 is Mapperatorinator installed? list style tags

training data (public dataset project-riz/osu-beatmaps on Hugging Face: ranked/loved maps
with audio; osu! Terms of Service, research/personal use only, do not redistribute):
  data-fetch -o DIR [--max-maps 200] [--keys 4,7] [--stars 2-5] [--mapper name1,name2]
             [--mapper-id 123,456] [--ln 0-0.2] [--years 2018-2025] [--status 1,2,4]
             [--variant compressed|original] [--shard N] [--max-shards N]
                                                    stream shards, keep matching osu!mania maps

LoRA (teach the AI your style from your own maps):
  lora-dataset  <maps.osz | folders | .osu ...> -o DATASET_DIR [--keys 4,7] [--tags t1,t2]
                [--no-auto-tags] [--year 2023]      collect + tag maps, compute star ratings
                [--convert-keys 7] [--ln-aug hybrid,full]   add clean converted copies (more data)
  lora-train    DATASET_DIR --name NAME [--preset cpu|gpu] [--steps N] [--batch N] [--grad-acc N]
                [--rank N] [--lr X] [--save-every 25] [--resume]
                                                    train here (no GPU: --preset cpu, runs overnight,
                                                    Ctrl+C keeps a usable LoRA, --resume continues)
  lora-notebook DATASET_DIR --name NAME [-o DIR]    no GPU? zip + notebook for a free Kaggle/Colab GPU
  lora-import   NAME-lora.zip --name NAME           install a LoRA trained in the cloud
  lora-list                                         LoRAs you can use with: ai --lora NAME

all keys:   --keys accepts 1..18
stars:      maniamap uses Star Rating Rebirth (2025 rework, works for 1K-18K); "osu!" figures
            are an estimate of the current in-game rating (about +-0.3)
`;

type Args = { _: string[]; [k: string]: string | boolean | string[] };

function parseArgs(argv: string[]): Args {
  const a: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '-o') a.o = argv[++i];
    else if (s.startsWith('--')) {
      const k = s.slice(2);
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith('--')) a[k] = true;
      else { a[k] = nxt; i++; }
    } else a._.push(s);
  }
  return a;
}

const num = (a: Args, k: string, d?: number): number | undefined => {
  const v = a[k];
  if (v === undefined || typeof v !== 'string') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) die(`--${k} must be a number`);
  return n;
};

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function loadMap(path: string): Beatmap {
  if (!path) die('missing input .osu file');
  if (!existsSync(path)) die(`file not found: ${path}`);
  return parseOsu(readFileSync(path, 'utf8'));
}

function saveMap(map: Beatmap, input: string, cmd: string, a: Args) {
  const out = (a.o as string) ?? join(dirname(input), `${basename(input, extname(input))}.${cmd}.osu`);
  writeFileSync(out, writeOsu(map));
  console.log(`wrote ${out}  (${map.notes.length} notes, ${getKeys(map)}K)`);
}

function hasFfmpeg(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

export function decodeWithFfmpeg(path: string, sampleRate = 22050): Float32Array {
  if (!hasFfmpeg()) die('ffmpeg not found. On Debian: sudo apt install ffmpeg');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'], {
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.status !== 0) die(`ffmpeg failed: ${r.stderr?.toString()}`);
  const buf = r.stdout as Buffer;
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice();
}

/** contrast-aware star adjustment: the song's loudness for this map (null without ffmpeg or audio) */
function loudnessFromAudio(path: string | undefined, map: Beatmap): ((t: number) => number) | undefined {
  if (!path || !existsSync(path) || !hasFfmpeg()) return undefined;
  try { return loudnessForMap(analyze(decodeWithFfmpeg(path, 22050), 22050), map); } catch { return undefined; }
}

/** left and right channels, or null for mono files */
export function decodeStereoWithFfmpeg(path: string, sampleRate = 22050): [Float32Array, Float32Array] | null {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', path], { encoding: 'utf8' });
  if (probe.status === 0 && Number(probe.stdout.trim()) < 2) return null;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '2', '-ar', String(sampleRate), '-f', 'f32le', '-'], { maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const buf = r.stdout as Buffer;
  const all = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const n = all.length >> 1, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = all[2 * i]; R[i] = all[2 * i + 1]; }
  return [L, R];
}

function fmtMs(ms: number): string {
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(Math.round(ms) % 1000).padStart(3, '0')}`;
}

function sparkline(v: Float32Array, width: number): string {
  if (!v.length) return '';
  const bars = '▁▂▃▄▅▆▇█';
  const per = v.length / width;
  const cols: number[] = [];
  for (let i = 0; i < Math.min(width, v.length); i++) {
    let m = 0;
    for (let j = Math.floor(i * per); j < Math.max(Math.floor(i * per) + 1, Math.floor((i + 1) * per)); j++) m = Math.max(m, v[j] ?? 0);
    cols.push(m);
  }
  const max = Math.max(...cols, 1e-9);
  return cols.map((x) => bars[Math.min(7, Math.floor((x / max) * 7.999))]).join('');
}

function printPatterns(map: Beatmap, a: Args) {
  const r = classifyPatterns(map);
  if (a.json) {
    console.log(JSON.stringify({
      keys: r.keys, category: r.category, slot: r.slot, mode: r.mode, lnRatio: r.lnRatio,
      summary: summarize(r), suggestedTags: r.suggestedTags, tagScores: r.tagScores, categories: r.categories,
      byTime: r.byTime, byNotes: r.byNotes, byGroup: r.byGroup, byCore: r.byCore, stats: r.stats,
      sections: r.sections.map(({ firstRow, lastRow, ...s }) => s),
    }, null, 2));
    return;
  }
  const m = map.metadata;
  console.log(`${m.get('Artist')} - ${m.get('Title')} [${m.get('Version')}]  (${r.keys}K, ${map.notes.length} notes)`);
  if (!r.sections.length) { console.log('no notes'); return; }
  console.log(`\ncategory: ${r.category}    slot: ${r.slot}    LN ${(r.lnRatio * 100).toFixed(0)}% (${r.mode})`);
  console.log(`summary:  ${summarize(r, 6)}\n`);
  const bar = (v: number) => '█'.repeat(Math.round(v * 30)).padEnd(30, '·');
  for (const t of r.dominant) {
    console.log(`  ${PATTERN_INFO[t].name.padEnd(18)} ${bar(r.byTime[t]!)} ${(r.byTime[t]! * 100).toFixed(1).padStart(5)}% time  ${(r.byNotes[t]! * 100).toFixed(1).padStart(5)}% notes`);
  }
  console.log('\nskillsets:  ' + Object.entries(r.byGroup).sort((x, y) => y[1]! - x[1]!).map(([g, v]) => `${g} ${(v! * 100).toFixed(0)}%`).join(' · '));
  console.log('\nsuggested osu! user tags:');
  if (!r.suggestedTags.length) console.log('  (none)');
  for (const t of r.suggestedTags) console.log(`  ${t.tag.padEnd(24)} ${t.score !== undefined ? t.score.toFixed(2) : '    '}  ${t.reason}`);
  const minRows = num(a, 'min-rows', 8)!;
  console.log(`\nsections (>= ${minRows} rows; --min-rows to change):`);
  for (const s of r.sections.filter((x) => x.rows >= minRows)) {
    console.log(`  ${fmtMs(s.start).padStart(9)} – ${fmtMs(s.end).padEnd(9)} ${PATTERN_INFO[s.type as PatternType].name.padEnd(18)} ${String(s.notes).padStart(5)} notes  ${s.nps.toFixed(1).padStart(5)} nps  ${s.speed.padEnd(14)} ${describeTags(s)}`);
  }
}

function printDirt(before: Beatmap, after: Beatmap) {
  const b = T.dirt(before);
  const d = T.dirt(after);
  const ln = (m: Beatmap) => `${Math.round((m.notes.filter((n) => n.endTime !== undefined && n.endTime > n.time).length / Math.max(1, m.notes.length)) * 100)}% LN`;
  const f = (x: number) => x.toFixed(1);
  console.log(`clean check (per 1000 notes; lower is cleaner)   before -> after`);
  console.log(`  notes ${b.notes} -> ${d.notes}   ${ln(before)} -> ${ln(after)}`);
  console.log(`  fast jacks ${f(b.fastJacks)} -> ${f(d.fastJacks)}   jacks ${f(b.jacks)} -> ${f(d.jacks)}   hand overload ${f(b.handOverload)} -> ${f(d.handOverload)}   hand imbalance ${b.handImbalance.toFixed(2)} -> ${d.handImbalance.toFixed(2)}`);
  console.log(`  short LNs ${f(b.shortLNs)} -> ${f(d.shortLNs)}   tight releases ${f(b.tightReleases)} -> ${f(d.tightReleases)}   off-grid releases ${f(b.offGridReleases)} -> ${f(d.offGridReleases)}   locked holds ${f(b.lockedHolds)} -> ${f(d.lockedHolds)}`);
  console.log(`  dirt score ${f(b.score)} -> ${f(d.score)}`);
}

function printInfo(map: Beatmap) {
  const s = T.stats(map);
  const m = map.metadata;
  const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  console.log(`${m.get('Artist')} - ${m.get('Title')} [${m.get('Version')}] by ${m.get('Creator')}`);
  console.log(`keys ${s.keys}K | OD ${map.difficulty.get('OverallDifficulty')} | HP ${map.difficulty.get('HPDrainRate')} | BPM ${s.mainBpm}`);
  console.log(`notes ${s.notes} (rice ${s.rice}, LN ${s.lns} = ${s.lnPercent.toFixed(1)}%) | length ${fmt(s.lastTime)}`);
  console.log(`NPS avg ${s.avgNps.toFixed(2)} | peak ${s.peakNps} | jacks ${s.jacks}`);
  if (map.notes.length) {
    const st = starRating(map).stars;
    console.log(`stars     ${st.toFixed(2)} (Rebirth) ~ ${rebirthToOfficial(st, s.lnPercent / 100).toFixed(2)} osu!`);
  }
  console.log(`columns   ${s.columnCounts.join(' ')}`);
  console.log(`chords    ${s.chordSizes.map((c, i) => `${i + 1}:${c}`).filter((x) => !x.endsWith(':0')).join(' ')}`);
  const issues = T.validate(map);
  if (!issues.length) console.log('problems  none');
  else {
    console.log(`problems  ${issues.length}`);
    for (const i of issues.slice(0, 20)) {
      console.log(`  ${i.severity.padEnd(7)} ${String(i.time).padStart(7)}ms${i.column !== undefined ? ` col ${i.column + 1}` : ''}  ${i.message}`);
    }
    if (issues.length > 20) console.log(`  ... and ${issues.length - 20} more`);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- editor API (AI jobs)

interface ServerJob {
  id: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  log: string[];
  started: number;
  job?: AiJob | MugJob;
  osu?: string;
  styleCheck?: unknown;
  removedOverlaps?: number;
  stars?: number;
  fitFrom?: number;
  error?: string;
}
let currentJob: ServerJob | null = null;

function sendJson(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 120 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** an engine setup started from the app (one at a time) */
interface SetupJob { id: string; what: 'ai' | 'mug'; state: 'running' | 'done' | 'error' | 'cancelled'; log: string[]; started: number; child?: ReturnType<typeof spawn>; exit?: number | null }
let setupJob: SetupJob | null = null;

function startSetup(what: 'ai' | 'mug', cpu: boolean): SetupJob {
  const script = join(scriptsDir(dirname(fileURLToPath(import.meta.url))), what === 'ai' ? 'setup-mapperatorinator.sh' : 'setup-mug-diffusion.sh');
  const job: SetupJob = { id: Math.random().toString(36).slice(2), what, state: 'running', log: [], started: Date.now() };
  // install where maniamap looks (environment, settings file or default) and remember it
  const dir = what === 'ai' ? defaultAiDir() : defaultMugDir();
  const dirVar = what === 'ai' ? 'MAPPERATORINATOR_DIR' : 'MUG_DIFFUSION_DIR';
  const child = spawn('bash', [script, ...(cpu ? ['--cpu'] : [])], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, [dirVar]: dir, PYTHONUNBUFFERED: '1' } });
  job.child = child;
  const push = (chunk: Buffer) => {
    // progress bars rewrite one line with \r: keep the latest state of each line
    for (const part of chunk.toString('utf8').split('\n')) {
      const line = part.split('\r').filter(Boolean).pop() ?? '';
      if (!line.trim()) continue;
      job.log.push(line.slice(0, 300));
      if (job.log.length > 400) job.log.shift();
    }
  };
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  child.on('close', (code) => {
    job.exit = code;
    if (job.state === 'running') job.state = code === 0 ? 'done' : 'error';
    if (code === 0) saveConfig(what === 'ai' ? { aiDir: dir } : { mugDir: dir });
  });
  child.on('error', (e) => { job.log.push(String(e)); job.state = 'error'; });
  console.log(`setup ${what} started from the app`);
  return job;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, a: Args) {
  { const plat = checkThisSystem(); if (!plat.ok) return sendJson(res, 403, { error: plat.reason }); }
  // a custom header cannot be sent cross-site without a CORS preflight (which we never answer),
  // so other web pages cannot start jobs on this machine
  if (req.headers['x-maniamap'] !== '1') return sendJson(res, 403, { error: 'forbidden' });
  try {
    if (path === '/api/quit' && req.method === 'POST') {
      sendJson(res, 200, { ok: true });
      quitEditor();
      return;
    }
    if (path === '/api/doctor' && req.method === 'GET') {
      return sendJson(res, 200, { version: VERSION, checks: runChecks(), setup: setupJob && { id: setupJob.id, what: setupJob.what, state: setupJob.state } });
    }
    if (path === '/api/setup' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const what = body.what === 'mug' ? 'mug' : body.what === 'ai' ? 'ai' : null;
      if (!what) return sendJson(res, 400, { error: 'what must be ai or mug' });
      if (setupJob?.state === 'running') return sendJson(res, 409, { error: `a setup (${setupJob.what}) is already running`, id: setupJob.id });
      setupJob = startSetup(what, !!body.cpu);
      return sendJson(res, 200, { id: setupJob.id });
    }
    const sm = /^\/api\/setup\/(\w+)(\/cancel)?$/.exec(path);
    if (sm) {
      if (!setupJob || setupJob.id !== sm[1]) return sendJson(res, 404, { error: 'no such setup' });
      if (sm[2] && req.method === 'POST') { if (setupJob.state === 'running') { setupJob.state = 'cancelled'; setupJob.child?.kill('SIGTERM'); } return sendJson(res, 200, { state: setupJob.state }); }
      const since = Number(new URL(req.url ?? '', 'http://x').searchParams.get('since') ?? 0);
      return sendJson(res, 200, { state: setupJob.state, exit: setupJob.exit, what: setupJob.what, seconds: Math.round((Date.now() - setupJob.started) / 1000), log: setupJob.log.slice(-60), total: setupJob.log.length, since });
    }
    if (path === '/api/ai/status' && req.method === 'GET') {
      const inst = findAiInstall((a['ai-dir'] as string) || undefined);
      const mug = findMugInstall((a['mug-dir'] as string) || undefined);
      return sendJson(res, 200, {
        version: VERSION, available: inst.available, problem: inst.problem, dir: inst.dir, busy: currentJob?.state === 'running', loras: listLoras().map((l) => ({ name: l.name, info: l.info })),
        mug: { available: mug.available, problem: mug.problem },
      });
    }
    if (path === '/api/ai/jobs' && req.method === 'POST') {
      if (currentJob?.state === 'running') return sendJson(res, 409, { error: 'a generation is already running' });
      const body = JSON.parse(await readBody(req));
      if (body.engine === 'mug') {
        // MuG Diffusion (osu!mania 4K)
        const mug = findMugInstall((a['mug-dir'] as string) || undefined);
        if (!mug.available) return sendJson(res, 400, { error: mug.problem });
        const work = mkdtempSync(join(tmpdir(), 'maniamap-audio-'));
        const audioName = basename(String(body.audioName || 'audio.mp3')).replace(/[^\w.\- ]/g, '_') || 'audio.mp3';
        const audioPath = join(work, audioName);
        writeFileSync(audioPath, Buffer.from(String(body.audioBase64 || ''), 'base64'));
        const target = Number(body.stars ?? 3.5);
        const ln = Number(body.ln ?? 0.05);
        const sj: ServerJob = { id: Math.random().toString(36).slice(2), state: 'running', log: [], started: Date.now() };
        currentJob = sj;
        let job;
        try {
          job = runMug({
            audioPath, audioName: String(body.audioName || audioName), stars: rebirthToOfficial(target, ln), lnRatio: ln,
            patterns: mugPatternsForStyle(typeof body.style === 'string' ? body.style : undefined), count: 1,
            steps: Number(body.steps ?? 50), cfg: Number(body.cfgMug ?? 5), seed: body.seed !== undefined ? Number(body.seed) : undefined,
            bpm: Number(body.bpm) > 0 ? Number(body.bpm) : undefined, offset: Number(body.offset ?? 0),
            title: typeof body.title === 'string' ? body.title : undefined, artist: typeof body.artist === 'string' ? body.artist : undefined,
          }, mugRunner(), (line) => { sj.log.push(line); if (sj.log.length > 200) sj.log.shift(); }, mug);
        } catch (e) {
          rmSync(work, { recursive: true, force: true });
          sj.state = 'error'; sj.error = (e as Error).message;
          return sendJson(res, 400, { error: sj.error });
        }
        sj.job = job;
        job.done.then((r) => {
          const post = postprocessAiMap(r.osuTexts[0], { keys: 4, stars: +target.toFixed(1), audioFilename: body.audioName, title: body.title, artist: body.artist, engine: 'mug' });
          sj.stars = starRating(post.map).stars;
          if (body.fit && Math.abs(sj.stars - target) > 0.1) {
            const f = fitDifficulty(post.map, target, { seed: Number(body.seed) || 1, loudness: loudnessFromAudio(audioPath, post.map) });
            sj.fitFrom = sj.stars;
            post.map = f.map;
            sj.stars = f.stars;
          }
          sj.osu = writeOsu(post.map);
          sj.state = 'done';
        }).catch((e: Error) => {
          sj.state = sj.state === 'cancelled' ? 'cancelled' : 'error';
          sj.error = e.message;
        }).finally(() => rmSync(work, { recursive: true, force: true }));
        return sendJson(res, 200, { id: sj.id });
      }
      const inst = findAiInstall((a['ai-dir'] as string) || undefined);
      if (!inst.available) return sendJson(res, 400, { error: inst.problem });
      const work = mkdtempSync(join(tmpdir(), 'maniamap-audio-'));
      const audioName = basename(String(body.audioName || 'audio.mp3')).replace(/[^\w.\- ]/g, '_') || 'audio.mp3';
      const audioPath = join(work, audioName);
      writeFileSync(audioPath, Buffer.from(String(body.audioBase64 || ''), 'base64'));
      const keys = Number(body.keys);
      const opts: AiOptions = {
        audioPath, keys, stars: rebirthToOfficial(Number(body.stars ?? 3.5), Number(body.ln ?? 0.1)), holdNoteRatio: Number(body.ln ?? 0.1), scrollSpeedRatio: Number(body.sv ?? 0),
        descriptors: Array.isArray(body.tags) ? body.tags : undefined, negativeDescriptors: Array.isArray(body.avoid) && body.avoid.length ? body.avoid : undefined,
        year: Number(body.year ?? 2023), cfgScale: Number(body.cfg ?? 1), seed: body.seed !== undefined ? Number(body.seed) : undefined,
        timingOsuText: typeof body.timingOsu === 'string' ? body.timingOsu : undefined,
        startTime: body.start !== undefined && body.start !== null ? Number(body.start) : undefined,
        endTime: body.end !== undefined && body.end !== null ? Number(body.end) : undefined,
        device: typeof body.device === 'string' ? body.device : 'auto',
        title: typeof body.title === 'string' ? body.title : undefined, artist: typeof body.artist === 'string' ? body.artist : undefined,
        loraPath: body.lora === 'default'
          ? (() => { const d = defaultLora(keys, listLoras().map((l) => l.name)); return d ? resolveLora(d) : undefined; })()
          : typeof body.lora === 'string' && body.lora ? resolveLora(body.lora) : undefined,
        mapperId: Number.isFinite(Number(body.mapperId)) && Number(body.mapperId) > 0 ? Number(body.mapperId) : undefined,
        model: body.model === 'v32-mini' ? 'v32-mini' : 'v32',
      };
      opts.stars = modelStars(keys, opts.stars!, !!opts.mapperId);
      const sj: ServerJob = { id: Math.random().toString(36).slice(2), state: 'running', log: [], started: Date.now() };
      currentJob = sj;
      try {
        sj.job = runMapperatorinator(opts, (line) => { sj.log.push(line); if (sj.log.length > 200) sj.log.shift(); }, inst);
      } catch (e) {
        rmSync(work, { recursive: true, force: true });
        sj.state = 'error'; sj.error = (e as Error).message;
        return sendJson(res, 400, { error: sj.error });
      }
      sj.job.done.then((r) => {
        const target = Number(body.stars ?? 3.5);
        const post = postprocessAiMap(r.osuText, { keys, stars: +target.toFixed(1), audioFilename: body.audioName, title: opts.title, artist: opts.artist, requestedTags: opts.descriptors });
        sj.stars = starRating(post.map).stars;
        if (body.fit && Math.abs(sj.stars - target) > 0.1) {
          const f = fitDifficulty(post.map, target, { seed: opts.seed, loudness: loudnessFromAudio(audioPath, post.map) });
          sj.fitFrom = sj.stars;
          post.map = f.map;
          sj.stars = f.stars;
        }
        sj.osu = writeOsu(post.map);
        sj.styleCheck = post.styleCheck;
        sj.removedOverlaps = post.removedOverlaps;
        sj.state = 'done';
      }).catch((e: Error) => {
        sj.state = sj.state === 'cancelled' ? 'cancelled' : 'error';
        sj.error = e.message;
      }).finally(() => rmSync(work, { recursive: true, force: true }));
      console.log(`AI job ${sj.id}: ${keys}K ${opts.stars}*${opts.descriptors ? ' ' + opts.descriptors.join(',') : ''}`);
      return sendJson(res, 200, { id: sj.id });
    }
    const m = /^\/api\/ai\/jobs\/(\w+)$/.exec(path);
    if (m) {
      const sj = currentJob && currentJob.id === m[1] ? currentJob : null;
      if (!sj) return sendJson(res, 404, { error: 'no such job' });
      if (req.method === 'DELETE') {
        if (sj.state === 'running') { sj.state = 'cancelled'; sj.job?.cancel(); }
        return sendJson(res, 200, { state: sj.state });
      }
      return sendJson(res, 200, {
        state: sj.state, seconds: Math.round((Date.now() - sj.started) / 1000), log: sj.log.slice(-12),
        osu: sj.osu, styleCheck: sj.styleCheck, removedOverlaps: sj.removedOverlaps, stars: sj.stars, fitFrom: sj.fitFrom, error: sj.error,
      });
    }
    return sendJson(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    return sendJson(res, 500, { error: (e as Error).message });
  }
}

/** is maniamap already serving on this port? (a second launch then just opens it) */
function probeEditor(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/api/doctor', headers: { 'x-maniamap': '1' }, timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body).version ? `http://127.0.0.1:${port}/` : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function openBrowser(url: string) {
  try {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => console.log(`open ${url} in your browser`)).unref();
  } catch { console.log(`open ${url} in your browser`); }
}

let editorServer: ReturnType<typeof createServer> | null = null;

async function startEditor(a: Args) {
  { const plat = checkThisSystem(); if (!plat.ok) die(plat.reason); }
  // dist/cli.mjs -> dist/web ; src/cli.ts (dev, via tsx) -> ../dist/web
  const here = dirname(fileURLToPath(import.meta.url));
  const root = [join(here, 'web'), join(here, '..', 'dist', 'web')].find((d) => existsSync(join(d, 'index.html')));
  if (!root) die('the app files are missing (dist/web). Reinstall maniamap: ./install.sh');
  const first = num(a, 'port', 5173)!;
  // started from the applications menu (no terminal): keep a log for "maniamap doctor"-style help
  if (typeof a.log === 'string') {
    mkdirSync(dirname(a.log), { recursive: true });
    const sink = createWriteStream(a.log, { flags: 'a' });
    const write = (...x: unknown[]) => sink.write(`[${new Date().toISOString()}] ${x.map(String).join(' ')}\n`);
    console.log = write; console.warn = write; console.error = write;
  }
  // a folder set by environment variable (e.g. in ~/.bashrc) is remembered for menu launches
  for (const [v, key] of [['MAPPERATORINATOR_DIR', 'aiDir'], ['MUG_DIFFUSION_DIR', 'mugDir'], ['MANIAMAP_LORA_DIR', 'loraDir']] as const) {
    const d = process.env[v];
    if (d && existsSync(d)) { try { saveConfig({ [key]: d }); } catch { /* read-only config */ } }
  }
  // one instance: a second launch opens the running app instead of starting another server
  const running = await probeEditor(first);
  if (running) {
    console.log(`maniamap is already running at ${running}; opening it`);
    if (!a['no-open']) openBrowser(running);
    return;
  }
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (urlPath.startsWith('/api/')) { void handleApi(req, res, urlPath, a); return; }
    const file = normalize(join(root, urlPath === '/' ? 'index.html' : urlPath));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(file));
  });
  editorServer = server;
  let port = first;
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE' && port < first + 20) server.listen(++port, '127.0.0.1');
    else die(`cannot start the editor server: ${e.message}`);
  });
  server.on('listening', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`maniamap ${VERSION} running at ${url}  (Quit in the app, or Ctrl+C)`);
    if (!a['no-open']) openBrowser(url);
  });
  server.listen(port, '127.0.0.1');
}

const RELEASES = 'https://api.github.com/repos/WaterLily5297/mapping/releases/latest';

async function runUpdate(a: Args) {
  const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (existsSync(join(appRoot, '.git'))) {
    // a git checkout: pull and reinstall
    if (a.check) { spawnSync('git', ['-C', appRoot, 'fetch', '--quiet'], { stdio: 'inherit' }); spawnSync('git', ['-C', appRoot, 'status', '-sb'], { stdio: 'inherit' }); return; }
    console.log(`updating the git checkout in ${appRoot}`);
    if (spawnSync('git', ['-C', appRoot, 'pull', '--ff-only'], { stdio: 'inherit' }).status !== 0) die('git pull failed (local changes?). Resolve it, then run ./install.sh');
    const r = spawnSync('bash', [join(appRoot, 'install.sh')], { stdio: 'inherit', cwd: appRoot });
    if (r.status !== 0) die('the install step failed; see above');
    return;
  }
  // a release package: download the newest release next to this one and install it
  let rel: { tag_name: string; assets: { name: string; browser_download_url: string }[] };
  try {
    const res = await fetch(RELEASES, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'maniamap-updater' } });
    if (res.status === 404) { console.log(`no release has been published yet; you have maniamap ${VERSION}.`); return; }
    if (!res.ok) die(`could not check for updates (HTTP ${res.status})`);
    rel = await res.json() as typeof rel;
  } catch (e) { return die(`could not check for updates: ${(e as Error).message}`); }
  const latest = rel.tag_name.replace(/^v/, '');
  if (!newerVersion(latest, VERSION)) { console.log(`maniamap ${VERSION} is up to date.`); return; }
  console.log(`maniamap ${latest} is available (you have ${VERSION}).`);
  if (a.check) return;
  const asset = rel.assets.find((x) => /linux\.tar\.gz$/.test(x.name));
  const sum = rel.assets.find((x) => /linux\.tar\.gz\.sha256$/.test(x.name));
  if (!asset) die('the release has no Linux package; see https://github.com/WaterLily5297/mapping/releases');
  const work = mkdtempSync(join(tmpdir(), 'maniamap-update-'));
  const tgz = join(work, asset!.name);
  console.log(`downloading ${asset!.name}...`);
  writeFileSync(tgz, Buffer.from(await (await fetch(asset!.browser_download_url)).arrayBuffer()));
  if (sum) {
    const want = (await (await fetch(sum.browser_download_url)).text()).trim().split(/\s+/)[0];
    const got = createHash('sha256').update(readFileSync(tgz)).digest('hex');
    if (want !== got) die('the download does not match its checksum; not installing it');
  }
  const parent = dirname(appRoot);
  if (spawnSync('tar', ['-xzf', tgz, '-C', parent], { stdio: 'inherit' }).status !== 0) die('could not unpack the update');
  const fresh = join(parent, `maniamap-${latest}`);
  const r = spawnSync('bash', [join(fresh, 'install.sh')], { stdio: 'inherit', cwd: fresh });
  if (r.status !== 0) die('the install step failed; see above');
  console.log(`installed maniamap ${latest} in ${fresh}. The old folder ${appRoot} can be deleted.`);
}

/** stop everything the server started, then exit (the app's Quit button) */
function quitEditor() {
  console.log('quit from the app');
  try { setupJob?.child?.kill('SIGTERM'); } catch { /* gone */ }
  try { (currentJob?.job as { cancel?: () => void } | undefined)?.cancel?.(); } catch { /* gone */ }
  editorServer?.close();
  setTimeout(() => process.exit(0), 300).unref();
}

function writeChart(map: Beatmap, audioPath: string, out: string) {
  if (out.endsWith('.osz')) {
    writeFileSync(out, zipSync({
      [osuFileName(map)]: strToU8(writeOsu(map)),
      [basename(audioPath)]: [readFileSync(audioPath), { level: 0 }],
    }));
  } else writeFileSync(out, writeOsu(map));
  console.log(`wrote ${out}`);
}

function runPython(python: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { cwd, stdio: 'inherit', env: { ...process.env, PYTHONUNBUFFERED: '1', WANDB_MODE: 'disabled' } });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
    process.on('SIGINT', () => child.kill('SIGINT'));
  });
}

async function runLoraDataset(a: Args) {
  const inputs = a._.slice(1);
  const out = a.o as string;
  if (!inputs.length || !out) die('usage: maniamap lora-dataset <maps.osz | folders ...> -o DATASET_DIR');
  const install = findAiInstall((a['ai-dir'] as string) || undefined);
  if (!install.available) die(install.problem!);
  const list = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  console.log('collecting osu!mania maps...');
  const entries = buildDataset({
    inputs, out, keys: list('keys')?.map(Number), extraTags: list('tags'), autoTags: !a['no-auto-tags'],
    convertKeys: list('convert-keys')?.map(Number), lnPresets: list('ln-aug') as never,
    year: num(a, 'year', 2023), log: (s) => console.log(s),
  });
  if (!entries.length) die('no usable osu!mania maps found (each needs its audio file and at least 32 notes)');
  const sets = new Set(entries.map((e) => e.BeatmapSetId)).size;
  console.log(`${entries.length} maps from ${sets} songs. Computing star ratings...`);
  const here = dirname(fileURLToPath(import.meta.url));
  const code = await runPython(install.python, [join(scriptsDir(here), 'lora', 'build_metadata.py'), out]);
  if (code !== 0) die('building metadata.parquet failed');
  if (entries.length < 20) console.log(`note: ${entries.length} maps is very little for a LoRA; 30-200 maps of one style work better.`);
  console.log(`dataset ready: ${out}\nnext: maniamap lora-train ${out} --name my-style`);
}

async function runLoraTrain(dataset: string, a: Args) {
  if (!dataset || !existsSync(join(dataset, 'metadata.parquet'))) die('usage: maniamap lora-train DATASET_DIR --name NAME  (make DATASET_DIR with lora-dataset)');
  const name = a.name as string;
  if (!name || !/^[\w.-]+$/.test(name)) die('--name is required (letters, digits, . _ -)');
  const install = findAiInstall((a['ai-dir'] as string) || undefined);
  if (!install.available) die(install.problem!);
  const here = dirname(fileURLToPath(import.meta.url));
  const out = join(loraStoreDir(), name);
  // presets: cpu = small memory (batch 1) and lighter training; gpu = Mapperatorinator-like defaults
  const hasGpu = spawnSync('nvidia-smi', ['-L'], { stdio: 'ignore' }).status === 0;
  const preset = (a.preset as string) ?? (a.device === 'cpu' || !hasGpu ? 'cpu' : 'gpu');
  if (!['cpu', 'gpu'].includes(preset)) die('--preset must be cpu or gpu');
  if (preset === 'cpu' && !a.preset && !a.device) console.log('no NVIDIA GPU found: using --preset cpu (or train for free on a cloud GPU: maniamap lora-notebook)');
  const P = preset === 'cpu'
    ? { steps: 300, batch: 1, 'grad-acc': 4, rank: 16, device: 'cpu' }
    : { steps: 300, batch: 4, 'grad-acc': 8, rank: 64, device: 'gpu' };
  const v = (k: keyof typeof P) => (typeof a[k] === 'string' ? (a[k] as string) : String(P[k]));
  const args = [join(scriptsDir(here), 'lora', 'train_lora.py'), '--mai-dir', install.dir, '--dataset', dataset, '--out', out,
    '--steps', v('steps'), '--batch', v('batch'), '--grad-acc', v('grad-acc'), '--rank', v('rank'), '--device', v('device')];
  for (const k of ['lr', 'workers', 'save-every', 'precision']) if (typeof a[k] === 'string') args.push(`--${k}`, a[k] as string);
  if (a.resume) args.push('--resume');
  if (a.compile) args.push('--compile');
  if (v('device') === 'cpu') {
    // measured: about 21 s per training window (batch 1) on 4 cores; scale by core count
    const windows = Number(v('steps')) * Number(v('grad-acc')) * Number(v('batch'));
    const hours = (windows * 21 * (4 / Math.max(1, cpus().length))) / 3600;
    console.log(`CPU training: ${windows} windows, roughly ${hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`} on ${cpus().length} cores (rough estimate).`);
    console.log(`A usable LoRA is saved every ${typeof a['save-every'] === 'string' ? a['save-every'] : 25} steps; Ctrl+C keeps the latest one, --resume continues later.`);
    if (totalmem() < 12e9) console.log(`warning: ${(totalmem() / 1e9).toFixed(0)} GB RAM; training needs about 10 GB. Close other programs, or use: maniamap lora-notebook`);
    if (Number(v('batch')) > 1) console.log('warning: batch > 1 on CPU needs a lot of RAM (batch 4 did not fit in 15 GB)');
  }
  console.log(`training LoRA "${name}" (Ctrl+C to stop)...`);
  const code = await runPython(install.python, args, install.dir);
  if (code === 130) {
    console.log(`\nstopped. The latest checkpoint is saved as LoRA "${name}" (usable now);`);
    console.log(`continue training with: maniamap lora-train ${dataset} --name ${name} --resume  (same options)`);
    process.exit(130);
  }
  if (code !== 0) die(`training failed (exit ${code})`);
  console.log(`\nuse it with: maniamap ai song.mp3 --keys K --lora ${name}`);
}

/** --mapper auto | name | id -> a mapper id the model knows */
function resolveMapperArg(v: unknown, keys: number, officialStars: number): number | undefined {
  if (v === undefined || v === false) return undefined;
  if (v === true || v === 'auto') {
    const best = referenceMappers(keys, officialStars)[0];
    if (!best) { console.warn(`no reference mapper known for ${keys}K around ${officialStars.toFixed(1)} stars; generating without one`); return undefined; }
    return best.id;
  }
  if (/^\d+$/.test(String(v))) return Number(v);
  const m = MAPPERS.find((x) => x.name?.toLowerCase() === String(v).toLowerCase());
  if (!m) die(`mapper "${v}" is not known to the model (see: maniamap ai-mappers)`);
  return m!.id;
}

async function runAi(input: string, a: Args) {
  const keys = num(a, 'keys');
  if (!keys) die('--keys N is required (1..18)');
  if (!input || !existsSync(input)) die('missing audio file');
  const install = findAiInstall((a['ai-dir'] as string) || undefined);
  if (!install.available) die(install.problem!);
  const list = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  const opts: AiOptions = {
    audioPath: input, keys,
    stars: num(a, 'model-stars') ?? rebirthToOfficial(num(a, 'stars', 3.5)!, num(a, 'ln', 0.1)), holdNoteRatio: num(a, 'ln', 0.1), scrollSpeedRatio: num(a, 'sv', 0),
    descriptors: list('tags'), negativeDescriptors: list('avoid'), year: num(a, 'year', 2023),
    cfgScale: num(a, 'cfg', list('tags')?.length ? 1.5 : 1), seed: num(a, 'seed'),
    startTime: num(a, 'start'), endTime: num(a, 'end'), device: (a.device as string) ?? 'auto',
    loraPath: a.lora === 'none' ? undefined : typeof a.lora === 'string' ? resolveLora(a.lora)
      : (() => { const d = defaultLora(keys, listLoras().map((l) => l.name)); return d ? resolveLora(d) : undefined; })(),
    model: a.model === 'mini' || a.model === 'v32-mini' ? 'v32-mini' : a.model === 'v32' ? 'v32' : aiDefaultsFor(keys).model,
    mapperId: resolveMapperArg(a.mapper === 'none' ? undefined : a.mapper ?? (aiDefaultsFor(keys).mapper === 'auto' ? 'auto' : undefined), keys, num(a, 'model-stars') ?? rebirthToOfficial(num(a, 'stars', 3.5)!, num(a, 'ln', 0.1))),
    title: (a.title as string) ?? basename(input, extname(input)), artist: a.artist as string,
    lookback: num(a, 'lookback'), lookahead: num(a, 'lookahead'),
  };
  if (typeof a.timing === 'string') {
    // only the red lines of that map, in a complete file (the AI rejects files with missing fields)
    const reds = loadMap(a.timing).timingPoints.filter((p) => p.uninherited && p.beatLength > 0);
    if (!reds.length) die(`${a.timing} has no timing (red lines)`);
    const tm = createBeatmap({ keys, bpm: 60000 / reds[0].beatLength, offset: reds[0].time, audioFilename: basename(input), title: opts.title });
    tm.timingPoints = reds.map((p) => ({ ...p }));
    opts.timingOsuText = writeOsu(tm);
    console.log(`using the timing of ${a.timing} (${reds.length} red line${reds.length === 1 ? '' : 's'})`);
  } else if (!a['ai-timing']) {
    // detecting the BPM here is much faster than letting the model generate timing
    const sr = 22050;
    const lines = detectTiming(analyze(decodeWithFfmpeg(input, sr), sr));
    const bpm = Math.round(60000 / lines[0].beatLength * 100) / 100, beat = lines[0].beatLength;
    const offset = ((lines[0].time % beat) + beat) % beat;
    const tm = createBeatmap({ keys, bpm, offset, audioFilename: basename(input), title: opts.title });
    if (lines.length > 1) {
      tm.timingPoints = toTimingPoints(lines);
      console.log(`detected ${lines.length} tempo sections: ${lines.map((l) => `${(60000 / l.beatLength).toFixed(1)} BPM at ${(l.time / 1000).toFixed(1)} s`).join(', ')} (use --timing map.osu or --ai-timing to change)`);
    } else console.log(`detected ${bpm} BPM, offset ${Math.round(offset)} ms (use --timing map.osu or --ai-timing to change)`);
    opts.timingOsuText = writeOsu(tm);
  }
  const target = num(a, 'model-stars') !== undefined ? officialToRebirth(opts.stars!, opts.holdNoteRatio ?? 0.1) : num(a, 'stars', 3.5)!;
  if (num(a, 'model-stars') === undefined) opts.stars = modelStars(keys, opts.stars!, !!opts.mapperId);
  console.log(`running Mapperatorinator ${opts.model === 'v32-mini' ? 'V32-mini' : 'V32'} mania model (${keys}K, target ${target.toFixed(2)} stars = model difficulty ${opts.stars!.toFixed(2)} osu!${opts.mapperId ? `, style of mapper ${mapperName(opts.mapperId)}` : ''}${opts.loraPath ? `, LoRA ${basename(opts.loraPath)}` : ''}${opts.descriptors ? `, ${opts.descriptors.join(', ')}` : ''})... the first run downloads the model (~0.9 GB)`);
  let last = 0;
  const job = runMapperatorinator(opts, (line) => {
    // keep the terminal readable: show progress bars at most once per second
    const now = Date.now();
    if (/\d+%\|/.test(line)) { if (now - last > 1000) { last = now; process.stdout.write(`\r  ${line.slice(0, 110).padEnd(110)}`); } return; }
    if (/error|warn|saved|Using|seed|LoRA|Model loaded/i.test(line)) console.log(`\n  ${line.slice(0, 160)}`);
  }, install);
  process.on('SIGINT', () => { job.cancel(); process.exit(130); });
  const res = await job.done.catch((e: Error) => die(e.message));
  console.log('');
  const post = postprocessAiMap(res.osuText, {
    keys, stars: +target.toFixed(1), audioFilename: basename(input), title: opts.title, artist: opts.artist, requestedTags: opts.descriptors,
  });
  if (post.removedOverlaps) console.log(`removed ${post.removedOverlaps} overlapping notes`);
  const got = starRating(post.map).stars;
  console.log(`AI result: ${got.toFixed(2)} stars (target ${target.toFixed(2)})`);
  if (a.fit && Math.abs(got - target) > 0.1) {
    const f = fitDifficulty(post.map, target, { seed: num(a, 'seed'), loudness: loudnessFromAudio(input, post.map) });
    console.log(`  --fit: ${f.stars.toFixed(2)} stars${f.removed ? ` (removed ${f.removed} notes)` : ''}${f.added ? ` (added ${f.added} notes)` : ''}${f.reached ? '' : ' — closest clean result'}`);
    post.map = f.map;
  }
  printInfo(post.map);
  const r = classifyPatterns(post.map);
  console.log(`\npatterns: ${r.category} — ${summarize(r, 4)}`);
  for (const c of post.styleCheck) console.log(`  requested ${c.tag.padEnd(22)} ${c.matched ? 'found' : 'NOT found'}${c.score !== undefined ? ` (score ${c.score.toFixed(2)})` : ''}`);
  writeChart(post.map, input, (a.o as string) ?? join(dirname(input), `${basename(input, extname(input))}.${keys}k-ai.osz`));
}

/** MuG Diffusion (4K): the runner script that ships with maniamap */
function mugRunner(): string {
  return join(scriptsDir(dirname(fileURLToPath(import.meta.url))), 'mug', 'mug_generate.py');
}

async function runMugCli(input: string, a: Args) {
  if (!input || !existsSync(input)) die('missing audio file');
  if ((num(a, 'keys') ?? 4) !== 4) die('MuG Diffusion maps 4K only (use the AI or rules engine for other key counts)');
  const install = findMugInstall((a['mug-dir'] as string) || undefined);
  if (!install.available) die(install.problem!);
  const target = num(a, 'stars', 3.5)!;
  const ln = num(a, 'ln', a.style === 'ln' ? 0.5 : 0.05)!;
  let bpm: number | undefined, offset: number | undefined;
  if (typeof a.timing === 'string') {
    const red = loadMap(a.timing).timingPoints.find((p) => p.uninherited);
    if (red) { bpm = 60000 / red.beatLength; offset = red.time; console.log(`using the timing of ${a.timing}`); }
  } else {
    const t = estimateTempo(analyze(decodeWithFfmpeg(input, 22050), 22050));
    const beat = 60000 / t.bpm;
    bpm = t.bpm; offset = ((t.offset % beat) + beat) % beat;
    console.log(`detected ${t.bpm} BPM, offset ${Math.round(offset)} ms (use --timing map.osu to change)`);
  }
  const title = (a.title as string) ?? basename(input, extname(input));
  const opts: MugOptions = {
    audioPath: input, audioName: basename(input), stars: rebirthToOfficial(target, ln), lnRatio: ln,
    patterns: mugPatternsForStyle(a.style as string), count: 1, steps: num(a, 'steps', 50), cfg: num(a, 'cfg', 5), seed: num(a, 'seed'),
    bpm, offset, title, artist: a.artist as string,
  };
  console.log(`running MuG Diffusion (4K, target ${target.toFixed(2)} stars = ${opts.stars.toFixed(2)} osu!${opts.patterns ? `, more ${Object.keys(opts.patterns).join(', ')}` : ''}, ${opts.steps} steps)`);
  console.log('note: MuG Diffusion weights and the charts they create are non-commercial');
  let last = 0;
  const job = runMug(opts, mugRunner(), (line) => {
    const now = Date.now();
    if (/\d+%\|/.test(line)) { if (now - last > 1000) { last = now; process.stdout.write(`\r  ${line.slice(-90).padEnd(90)}`); } return; }
    if (/model loaded|prompt|first run|error|Error/i.test(line)) console.log(`\n  ${line.slice(0, 160)}`);
  }, install);
  process.on('SIGINT', () => { job.cancel(); process.exit(130); });
  const res = await job.done.catch((e: Error) => die(e.message));
  console.log('');
  const post = postprocessAiMap(res.osuTexts[0], { keys: 4, stars: +target.toFixed(1), audioFilename: basename(input), title, artist: opts.artist, engine: 'mug' });
  const got = starRating(post.map).stars;
  console.log(`MuG result: ${got.toFixed(2)} stars (target ${target.toFixed(2)})`);
  if (!a['no-fit'] && Math.abs(got - target) > 0.1) {
    const f = fitDifficulty(post.map, target, { seed: num(a, 'seed'), loudness: loudnessFromAudio(input, post.map) });
    console.log(`  fit: ${f.stars.toFixed(2)} stars${f.removed ? ` (removed ${f.removed} notes)` : ''}${f.added ? ` (added ${f.added} notes)` : ''}`);
    post.map = f.map;
  }
  printInfo(post.map);
  const r = classifyPatterns(post.map);
  console.log(`\npatterns: ${r.category} — ${summarize(r, 4)}`);
  writeChart(post.map, input, (a.o as string) ?? join(dirname(input), `${basename(input, extname(input))}.4k-mug.osz`));
}

async function main() {
  const plat = checkThisSystem();
  if (!plat.ok) die(plat.reason);
  const a = parseArgs(process.argv.slice(2));
  const [cmd, input] = a._;
  if (a.version || cmd === 'version') { console.log(`maniamap ${VERSION}`); return; }
  if (!cmd || cmd === 'help' || a.help) { console.log(HELP); return; }

  switch (cmd) {
    case 'doctor': {
      console.log(`maniamap ${VERSION}\n`);
      console.log(formatChecks(runChecks()));
      return;
    }
    case 'update': return void (await runUpdate(a));
    case 'setup': {
      const what = input;
      if (what !== 'ai' && what !== 'mug') die('usage: maniamap setup ai|mug [--cpu]   (ai: Mapperatorinator, the best engine; mug: MuG Diffusion, 4K only)');
      const script = join(scriptsDir(dirname(fileURLToPath(import.meta.url))), what === 'ai' ? 'setup-mapperatorinator.sh' : 'setup-mug-diffusion.sh');
      const dir = what === 'ai' ? defaultAiDir() : defaultMugDir();
      const r = spawnSync('bash', [script, ...(a.cpu ? ['--cpu'] : [])], { stdio: 'inherit', env: { ...process.env, [what === 'ai' ? 'MAPPERATORINATOR_DIR' : 'MUG_DIFFUSION_DIR']: dir } });
      if (r.status !== 0) die(`setup stopped (exit ${r.status}). Run "maniamap doctor" to see what is missing; running the setup again continues where it stopped.`);
      // remembered for every launch, including the applications menu (which does not read ~/.bashrc)
      saveConfig(what === 'ai' ? { aiDir: dir } : { mugDir: dir });
      console.log('\n' + formatChecks(runChecks().filter((c) => ['ai', 'mug', 'gpu'].includes(c.id))));
      return;
    }
    case 'editor': return void (await startEditor(a));
    case 'patterns': {
      if (input?.endsWith('.osz')) {
        for (const [name, data] of Object.entries(unzipSync(readFileSync(input)))) {
          if (!name.endsWith('.osu')) continue;
          try { printPatterns(parseOsu(strFromU8(data)), a); console.log(''); } catch (e) { console.log(`skipped ${name}: ${(e as Error).message}`); }
        }
      } else printPatterns(loadMap(input), a);
      return;
    }
    case 'sr': {
      const maps: [string, Beatmap][] = [];
      if (input?.endsWith('.osz')) {
        for (const [name, data] of Object.entries(unzipSync(readFileSync(input)))) {
          if (!name.endsWith('.osu')) continue;
          try { maps.push([name, parseOsu(strFromU8(data))]); } catch (e) { console.log(`skipped ${name}: ${(e as Error).message}`); }
        }
      } else maps.push([input, loadMap(input)]);
      const rate = num(a, 'rate', 1)!;
      const rows = maps.map(([name, m]) => {
        const r = starRating(m, { rate });
        const ln = m.notes.length ? m.notes.filter((n) => n.endTime !== undefined).length / m.notes.length : 0;
        return { name, version: m.metadata.get('Version'), keys: getKeys(m), stars: +r.stars.toFixed(3), osu: +rebirthToOfficial(r.stars, ln).toFixed(2), r };
      });
      if (a.json) { console.log(JSON.stringify(rows.map(({ r, ...x }) => x), null, 2)); return; }
      for (const x of rows) {
        console.log(`${x.version} (${x.keys}K${rate !== 1 ? `, ${rate}x` : ''}): ${x.stars.toFixed(2)} stars (Rebirth) ~ ${x.osu.toFixed(2)} osu!${x.r.extrapolated ? '  [key count outside the paper table: weights extrapolated]' : ''}`);
        console.log(`  ${sparkline(x.r.curve, 60)}  difficulty over time`);
      }
      return;
    }
    case 'adjust': {
      const target = num(a, 'stars');
      if (target === undefined) die('--stars X is required');
      const src = loadMap(input);
      // contrast-aware when the song is found: --audio FILE, or the map's AudioFilename next to it
      const audioFile = typeof a.audio === 'string' ? a.audio : src.general.get('AudioFilename') ? join(dirname(input), src.general.get('AudioFilename')!) : undefined;
      const loudness = a['no-contrast'] ? undefined : loudnessFromAudio(audioFile, src);
      if (loudness) console.log(`contrast-aware: notes leave quiet parts first and join loud parts (${basename(audioFile!)})`);
      const r = fitDifficulty(src, target!, { tolerance: num(a, 'tolerance', 0.1), seed: num(a, 'seed'), allowJacks: !!a['allow-jacks'], loudness });
      console.log(`stars ${r.startStars.toFixed(2)} -> ${r.stars.toFixed(2)} (target ${target!.toFixed(2)})${r.removed ? `, removed ${r.removed} notes` : ''}${r.added ? `, added ${r.added} notes` : ''}`);
      if (!r.reached) {
        console.log(r.stars < target!
          ? `  could not reach ${target} cleanly: there is no room for more notes without jacks.${a['allow-jacks'] ? '' : ' Try --allow-jacks,'} or a rate change (maniamap rate --rate 1.1)`
          : `  could not reach ${target}`);
      }
      printDirt(src, r.map);
      return saveMap(r.map, input, `${target}stars`, a);
    }
    case 'info': {
      if (input?.endsWith('.osz')) {
        const files = unzipSync(readFileSync(input));
        for (const [name, data] of Object.entries(files)) {
          if (!name.endsWith('.osu')) continue;
          console.log(`--- ${name}`);
          try { printInfo(parseOsu(strFromU8(data))); } catch (e) { console.log(`  skipped: ${(e as Error).message}`); }
        }
      } else printInfo(loadMap(input));
      return;
    }
    case 'convert': {
      const keys = num(a, 'keys');
      if (!keys) die('--keys N is required');
      const src = loadMap(input);
      const out = T.convertKeys(src, keys, { seed: num(a, 'seed', 1), fill: num(a, 'fill', 0), spreadJacks: !!a['spread-jacks'], segmentBeats: num(a, 'segment', 4) });
      printDirt(src, out);
      return saveMap(out, input, `${keys}k`, a);
    }
    case 'ln': {
      const src = loadMap(input);
      const pair = (k: string) => {
        if (typeof a[k] !== 'string') return undefined;
        const [ratio, level] = (a[k] as string).split(',').map(Number);
        return { ratio, level: level ?? 0.7 };
      };
      const preset = (a.preset as T.LnPreset) ?? 'hybrid';
      if (!(preset in T.LN_PRESETS)) die('--preset must be light, hybrid, full or inverse');
      const out = T.lnConvert(src, {
        preset, short: pair('short'), long: pair('long'), threshold: num(a, 'threshold'), align: num(a, 'align'),
        releaseGap: num(a, 'release-gap'), minBeats: num(a, 'min'), random: num(a, 'random'), seed: num(a, 'seed', 1),
        allowLocks: a['allow-locks'] ? true : undefined,
      });
      printDirt(src, out);
      return saveMap(out, input, `ln-${preset}`, a);
    }
    case 'mirror': return saveMap(T.mirror(loadMap(input)), input, cmd, a);
    case 'shuffle': {
      const map = loadMap(input);
      const seed = num(a, 'seed', Date.now())!;
      return saveMap(a.mode === 'random' ? T.randomize(map, seed) : T.permuteColumns(map, seed), input, cmd, a);
    }
    case 'fullln': return saveMap(T.fullLN(loadMap(input), { gapBeats: num(a, 'gap', 0.25), maxBeats: num(a, 'max-beats', 0) }), input, cmd, a);
    case 'inverse': return saveMap(T.inverseLN(loadMap(input), { gapBeats: num(a, 'gap', 0.125) }), input, cmd, a);
    case 'noln': return saveMap(T.removeLNs(loadMap(input)), input, cmd, a);
    case 'quantize': return saveMap(T.quantize(loadMap(input), num(a, 'divisor', 4)), input, cmd, a);
    case 'fix': return saveMap(T.fixOverlaps(loadMap(input)), input, cmd, a);
    case 'rate': {
      const rate = num(a, 'rate');
      if (!rate) die('--rate is required, e.g. --rate 1.2');
      const map = T.changeRate(loadMap(input), rate);
      const audio = map.general.get('AudioFilename');
      const audioPath = audio ? join(dirname(input), audio) : '';
      if (audio && existsSync(audioPath) && hasFfmpeg()) {
        const newAudio = `${basename(audio, extname(audio))}_${rate}x${extname(audio) || '.mp3'}`;
        // atempo supports 0.5..2 per filter; chain for other values
        const filters: string[] = [];
        let r = rate;
        while (r > 2) { filters.push('atempo=2'); r /= 2; }
        while (r < 0.5) { filters.push('atempo=0.5'); r /= 0.5; }
        filters.push(`atempo=${r}`);
        const res = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', audioPath, '-filter:a', filters.join(','), join(dirname(input), newAudio)]);
        if (res.status === 0) {
          map.general.set('AudioFilename', newAudio);
          console.log(`wrote audio ${newAudio}`);
        } else console.warn('ffmpeg audio rate change failed; only the chart was changed');
      } else console.warn('audio not changed (audio file or ffmpeg not found)');
      return saveMap(map, input, `${rate}x`, a);
    }
    case 'automap': {
      const keys = num(a, 'keys');
      if (!keys) die('--keys N is required (1..18)');
      if (!input || !existsSync(input)) die('missing audio file');
      // the AI model (Mapperatorinator V32 mania) when installed; quick rules only on request or as fallback
      const engine = (a.engine as string) ?? 'auto';
      if (!['auto', 'ai', 'rules', 'mug'].includes(engine)) die('bad --engine (ai, mug, rules)');
      if (engine === 'mug') return void (await runMugCli(input, a));
      const ai = findAiInstall((a['ai-dir'] as string) || undefined);
      if (engine === 'ai' && !ai.available) die(ai.problem!);
      if (engine !== 'rules' && ai.available) {
        console.log('engine: AI model (Mapperatorinator V32, osu!mania) — use --engine rules for an instant rule-based draft');
        const styleTags: Record<string, string> = { stream: 'skillset/streams', jumpstream: 'style/jumpstream', chordjack: 'style/chordjack', tech: 'skillset/tech', ln: 'style/LN mixed' };
        const st = a.style as string | undefined;
        return void (await runAi(input, {
          ...a, mapper: a.mapper ?? 'auto', fit: a.fit ?? true, stars: a.stars ?? '3.5',
          ...(st && styleTags[st] && !a.tags ? { tags: styleTags[st] } : {}),
          ...(a.ln === undefined ? { ln: st === 'ln' ? '0.5' : '0.05' } : {}),
          o: (a.o as string) ?? join(dirname(input), `${basename(input, extname(input))}.${keys}k.osz`),
        }));
      }
      console.log(ai.available
        ? 'engine: quick rules (instant draft, not the AI model)'
        : `engine: quick rules — the AI model is not installed (${ai.problem}); quality is much lower. Install it: maniamap setup ai`);
      const diff = (a.difficulty as Difficulty) ?? 'hard';
      if (a.stars === true) die('--stars needs a number, e.g. --stars 3.5');
      const style = (a.style as StyleChoice | undefined) ?? 'auto';
      if (style !== 'auto' && !(style in STYLES)) die(`bad --style (auto, ${Object.keys(STYLES).join(', ')})`);
      if (!['easy', 'normal', 'hard', 'insane', 'expert'].includes(diff)) die('bad --difficulty');
      console.log('decoding audio...');
      const sr = 22050;
      const direction = ((a.direction as string) ?? 'auto') as 'auto' | 'stereo' | 'pitch';
      if (!['auto', 'stereo', 'pitch'].includes(direction)) die('bad --direction (auto, stereo, pitch)');
      // stereo only matters for sound direction; mono analysis is the same either way
      const stereo = direction !== 'pitch' ? decodeStereoWithFfmpeg(input, sr) : null;
      const samples = stereo ? (() => { const [L, R] = stereo; const m = new Float32Array(L.length); for (let i = 0; i < L.length; i++) m[i] = (L[i] + R[i]) / 2; return m; })() : decodeWithFfmpeg(input, sr);
      const analysisOf = () => (stereo ? analyzeStereo(stereo[0], stereo[1], sr) : analyze(samples, sr));
      const audioFilename = basename(input);
      let lastStage = '';
      const targetStars = num(a, 'stars');
      const timingPoints = typeof a.timing === 'string' ? loadMap(a.timing).timingPoints.filter((p) => p.uninherited) : undefined;
      if (timingPoints) console.log(`using the timing of ${a.timing} (${timingPoints.length} red line${timingPoints.length === 1 ? '' : 's'})`);
      const genOpts = {
        keys, difficulty: diff, style, timingPoints,
        bpm: num(a, 'bpm'), offset: num(a, 'offset'), divisor: num(a, 'divisor'),
        density: num(a, 'density'), lnRatio: num(a, 'ln'), maxChord: num(a, 'max-chord'),
        pitchFollow: num(a, 'pitch'), direction, seed: num(a, 'seed'),
        metadata: {
          title: (a.title as string) ?? basename(input, extname(input)),
          artist: a.artist as string, creator: a.creator as string, audioFilename,
        },
        onProgress: (stage: string) => { if (stage !== lastStage) { lastStage = stage; console.log(`${stage}...`); } },
      };
      let map: Beatmap;
      if (targetStars !== undefined) {
        const an = analysisOf();
        // detected tempo changes become red lines (unless --timing or --bpm says otherwise)
        if (!genOpts.timingPoints && genOpts.bpm === undefined) {
          const lines = detectTiming(an);
          if (lines.length > 1) { genOpts.timingPoints = toTimingPoints(lines); console.log(`detected ${lines.length} tempo sections`); }
        }
        const dir = resolveDirection(an, direction);
        console.log(`sound direction: ${dir}${an.pan ? ` (stereo width ${stereoWidth(an).toFixed(2)})` : ' (mono)'}`);
        console.log(`searching for ${targetStars} stars...`);
        const r = generateForStars(an, { ...genOpts, difficulty: a.difficulty ? diff : undefined, targetStars, tolerance: num(a, 'tolerance', 0.1) });
        map = r.map;
        if (!a.difficulty) map.metadata.set('Version', `${keys}K ${r.stars.toFixed(1)}* (auto)`);
        console.log(`got ${r.stars.toFixed(2)} stars (${r.difficulty}, density ${r.density.toFixed(2)}${r.intensity > 1 ? `, intensity ${r.intensity.toFixed(2)}` : ''}; ${r.tries} tries)`);
        if (!r.reached) console.log(`  ${r.stars < targetStars ? `this song cannot go higher cleanly at ${keys}K (around ${r.stars.toFixed(1)} stars max); try more keys or a rate change` : 'could not go lower'}`);
      } else map = generateFromAnalysis(analysisOf(), genOpts);
      printInfo(map);
      const out = (a.o as string) ?? join(dirname(input), `${basename(input, extname(input))}.${keys}k.osz`);
      if (out.endsWith('.osz')) {
        const zip = zipSync({
          [osuFileName(map)]: strToU8(writeOsu(map)),
          [audioFilename]: [readFileSync(input), { level: 0 }],
        });
        writeFileSync(out, zip);
      } else writeFileSync(out, writeOsu(map));
      console.log(`wrote ${out}`);
      return;
    }
    case 'ai-mappers': {
      const keys = num(a, 'keys'), stars = num(a, 'stars');
      const list = keys && stars !== undefined ? referenceMappers(keys, rebirthToOfficial(stars), [], 25) : MAPPERS.filter((m) => m.name).slice(0, 40);
      for (const m of list) console.log(`  ${(m.name ?? '').padEnd(22)} id ${String(m.id).padEnd(9)} ${Object.entries(m.byKeys).map(([k, v]) => `${k}K ${v.min}-${v.max}* (${v.n})`).join(', ')}`);
      return;
    }
    case 'ai-status': {
      const inst = findAiInstall((a['ai-dir'] as string) || undefined);
      console.log(inst.available ? `Mapperatorinator found: ${inst.dir}\npython: ${inst.python}` : inst.problem);
      console.log('\nstyle tags for --tags / --avoid:');
      for (const d of MANIA_DESCRIPTORS) console.log(`  ${d.group.padEnd(11)} ${d.tag}`);
      return;
    }
    case 'ai': return void (await runAi(input, a));
    case 'mug': return void (await runMugCli(input, a));
    case 'mug-status': {
      const m = findMugInstall((a['mug-dir'] as string) || undefined);
      console.log(m.available ? `MuG Diffusion found: ${m.dir}\npython: ${m.python}\nlicence: weights and generated charts are non-commercial` : m.problem);
      return;
    }
    case 'lora-dataset': return void (await runLoraDataset(a));
    case 'data-fetch': {
      const out = a.o as string;
      if (!out) die('usage: maniamap data-fetch -o DIR [--max-maps 200] [--keys 4,7] [--stars 2-5] ...');
      const list = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).split(',').map((x) => x.trim()).filter(Boolean) : undefined);
      const range = (k: string): [number | undefined, number | undefined] => {
        if (typeof a[k] !== 'string') return [undefined, undefined];
        const [x, y] = (a[k] as string).split('-');
        return [x === '' ? undefined : Number(x), y === undefined ? Number(x) : y === '' ? undefined : Number(y)];
      };
      const [minStars, maxStars] = range('stars');
      const [minLn, maxLn] = range('ln');
      const [fromYear, toYear] = range('years');
      const variant = ((a.variant as string) ?? 'compressed') as Variant;
      if (!(variant in SHARDS)) die('--variant must be compressed or original');
      console.log('Data: project-riz/osu-beatmaps (osu! Terms of Service; research/personal use only).');
      const r = await fetchManiaData({
        out, maxMaps: num(a, 'max-maps', 200)!, variant, startShard: num(a, 'shard'), maxShards: num(a, 'max-shards'),
        filter: {
          keys: list('keys')?.map(Number), minStars, maxStars, mappers: list('mapper'), mapperIds: list('mapper-id')?.map(Number),
          minLn, maxLn, fromYear, toYear, statuses: list('status')?.map(Number),
        },
        log: (s) => console.log(s),
      });
      console.log(`done: ${r.maps} maps from ${r.sets} songs in ${out} (${r.scannedMaps} maps scanned in ${r.shardsRead} shard(s))`);
      if (r.maps) console.log(`next: maniamap lora-dataset ${out} -o ${out}-dataset`);
      return;
    }
    case 'lora-train': return void (await runLoraTrain(input, a));
    case 'lora-notebook': {
      const name = a.name as string;
      if (!input || !name || !/^[\w.-]+$/.test(name)) die('usage: maniamap lora-notebook DATASET_DIR --name NAME [-o DIR]');
      const outDir = (a.o as string) ?? '.';
      const here = dirname(fileURLToPath(import.meta.url));
      const zipPath = join(outDir, `${name}-dataset.zip`);
      const nbPath = join(outDir, `${name}-train.ipynb`);
      const size = zipDataset(input, zipPath);
      writeFileSync(nbPath, makeNotebook({
        name, trainScript: readFileSync(join(scriptsDir(here), 'lora', 'train_lora.py'), 'utf8'),
        steps: num(a, 'steps'), batch: num(a, 'batch'), gradAcc: num(a, 'grad-acc'), rank: num(a, 'rank'),
      }));
      console.log(`wrote ${zipPath} (${(size / 1e6).toFixed(1)} MB) and ${nbPath}`);
      console.log(`
Free GPU training:
  Kaggle: kaggle.com -> Create -> New Notebook -> File -> Import Notebook (${name}-train.ipynb)
          Settings: Accelerator "GPU T4 x2" or "P100", Internet on; Add Input -> Upload ${name}-dataset.zip
          Run All, then download ${name}-lora.zip from the Output tab.
  Colab:  colab.research.google.com -> File -> Upload notebook; Runtime -> Change runtime type -> T4 GPU;
          Run all and upload ${name}-dataset.zip when asked; the LoRA zip downloads at the end.
Then:   maniamap lora-import ${name}-lora.zip --name ${name}`);
      return;
    }
    case 'lora-import': {
      const name = a.name as string;
      if (!input || !name) die('usage: maniamap lora-import NAME-lora.zip --name NAME');
      const dest = importLora(input, loraStoreDir(), name);
      console.log(`installed LoRA "${name}" in ${dest}\nuse it with: maniamap ai song.mp3 --keys K --lora ${name}`);
      return;
    }
    case 'lora-list': {
      const ls = listLoras();
      console.log(`LoRA store: ${loraStoreDir()}`);
      if (!ls.length) console.log('  (none yet: maniamap lora-dataset ... then maniamap lora-train ...)');
      for (const l of ls) {
        const i = l.info as { beatmaps?: number; keys?: number[]; steps?: number; tags?: string[]; partial?: boolean; checkpoint?: string };
        const done = i.partial ? ` (partial: ${i.checkpoint ?? 'stopped early'})` : '';
        console.log(`  ${l.name.padEnd(20)} ${i.beatmaps ?? '?'} maps, ${(i.keys ?? []).join('/')}K, ${i.steps ?? '?'} steps${done}  ${(i.tags ?? []).slice(0, 6).join(', ')}`);
      }
      return;
    }
    default:
      die(`unknown command "${cmd}". Run "maniamap help".`);
  }
}

main().catch((e) => die((e as Error).message));
