/**
 * Stream osu!mania maps (+ audio) out of the public "project-riz/osu-beatmaps" dataset on
 * Hugging Face (ranked/loved osu! maps of all modes, WebDataset tar shards of ~1 GB).
 * Shards are streamed and filtered on the fly; only matching mania maps are written to disk.
 *
 * Dataset licence: osu! Terms of Service, research use only; the music is copyrighted.
 * Use the data for personal training/research, do not redistribute it.
 *
 * Output: <out>/<setId> <artist> - <title>/{audio.<ext>, <diff>.osu ..., maniamap-source.json}
 * which `maniamap lora-dataset` reads directly (mapper id, year and status are kept). Node only.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

export const DATASET = 'project-riz/osu-beatmaps';
export const SHARDS = { compressed: 74, original: 205 } as const;
export type Variant = keyof typeof SHARDS;

export function shardUrl(variant: Variant, i: number): string {
  return `https://huggingface.co/datasets/${DATASET}/resolve/main/${variant}/data-${String(i).padStart(6, '0')}.tar`;
}

export interface FetchFilter {
  keys?: number[];
  minStars?: number;
  maxStars?: number;
  /** mapper names (case-insensitive) */
  mappers?: string[];
  mapperIds?: number[];
  /** LN share of notes, 0..1 */
  minLn?: number;
  maxLn?: number;
  fromYear?: number;
  toYear?: number;
  /** osu! status: 1 ranked, 2 approved, 3 qualified, 4 loved */
  statuses?: number[];
}

export interface ApiBeatmap {
  beatmapset_id: number; beatmap_id: number; approved: number; version: string; diff_size: number; mode: number;
  count_normal: number; count_slider: number; approved_date: string | null; submit_date: string | null;
  artist: string; title: string; creator: string; creator_id: number; difficultyrating: number; content: string;
}

export function matches(b: ApiBeatmap, f: FetchFilter): boolean {
  if (Number(b.mode) !== 3) return false;
  const keys = Math.round(Number(b.diff_size));
  if (f.keys?.length && !f.keys.includes(keys)) return false;
  const stars = Number(b.difficultyrating);
  if (f.minStars !== undefined && stars < f.minStars) return false;
  if (f.maxStars !== undefined && stars > f.maxStars) return false;
  if (f.mappers?.length && !f.mappers.some((m) => m.toLowerCase() === String(b.creator).toLowerCase())) return false;
  if (f.mapperIds?.length && !f.mapperIds.includes(Number(b.creator_id))) return false;
  const total = Number(b.count_normal) + Number(b.count_slider);
  const ln = total ? Number(b.count_slider) / total : 0; // in mania, "sliders" are hold notes
  if (f.minLn !== undefined && ln < f.minLn) return false;
  if (f.maxLn !== undefined && ln > f.maxLn) return false;
  const year = Number(String(b.approved_date ?? b.submit_date ?? '').slice(0, 4));
  if (f.fromYear !== undefined && !(year >= f.fromYear)) return false;
  if (f.toYear !== undefined && !(year <= f.toYear)) return false;
  if (f.statuses?.length && !f.statuses.includes(Number(b.approved))) return false;
  return true;
}

// ---------------------------------------------------------------- streaming tar reader

/** Minimal streaming ustar reader: yields (name, data) for regular files. */
export async function* readTar(stream: AsyncIterable<Uint8Array>): AsyncGenerator<{ name: string; data: Buffer }> {
  let buf = Buffer.alloc(0);
  let longName: string | null = null;
  const it = stream[Symbol.asyncIterator]();
  let done = false;
  const need = async (n: number) => {
    while (buf.length < n && !done) {
      const r = await it.next();
      if (r.done) { done = true; break; }
      buf = buf.length ? Buffer.concat([buf, Buffer.from(r.value)]) : Buffer.from(r.value);
    }
    return buf.length >= n;
  };
  for (;;) {
    if (!(await need(512))) return;
    const h = buf.subarray(0, 512);
    if (h.every((x) => x === 0)) return; // end of archive
    const str = (a: number, b: number) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 500);
    let name = (prefix ? `${prefix}/` : '') + str(0, 100);
    const padded = Math.ceil(size / 512) * 512;
    if (!(await need(512 + padded))) throw new Error('truncated tar stream');
    const data = buf.subarray(512, 512 + size);
    buf = buf.subarray(512 + padded);
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    if (type === '0' || type === '\0') yield { name, data: Buffer.from(data) };
  }
}

/** HTTP stream through curl (respects proxies; present on most systems), falling back to fetch. */
export function openUrl(url: string): { stream: AsyncIterable<Uint8Array>; close(): void } {
  const headers = process.env.HF_TOKEN ? ['-H', `Authorization: Bearer ${process.env.HF_TOKEN}`] : [];
  if (spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0) {
    const child = spawn('curl', ['-sSfL', '--retry', '3', ...headers, url], { stdio: ['ignore', 'pipe', 'inherit'] });
    return { stream: child.stdout!, close: () => child.kill() };
  }
  const ctrl = new AbortController();
  const p = fetch(url, { signal: ctrl.signal, headers: process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {} });
  const stream = (async function* () {
    const r = await p;
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status} for ${url}`);
    yield* Readable.fromWeb(r.body as never) as AsyncIterable<Uint8Array>;
  })();
  return { stream, close: () => ctrl.abort() };
}

// ---------------------------------------------------------------- fetch

export interface FetchOptions {
  out: string;
  filter: FetchFilter;
  maxMaps: number;
  variant?: Variant;
  startShard?: number;
  maxShards?: number;
  log?: (s: string) => void;
  /** test hook: provide shard streams directly */
  open?: (variant: Variant, shard: number) => { stream: AsyncIterable<Uint8Array>; close(): void };
}

export interface FetchResult { maps: number; sets: number; shardsRead: number; scannedMaps: number }

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'x';

export async function fetchManiaData(o: FetchOptions): Promise<FetchResult> {
  const variant = o.variant ?? 'compressed';
  const log = o.log ?? (() => {});
  const open = o.open ?? ((v: Variant, i: number) => openUrl(shardUrl(v, i)));
  mkdirSync(o.out, { recursive: true });
  const statePath = join(o.out, 'fetch-state.json');
  const state: { done: string[] } = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { done: [] };
  let maps = 0, sets = 0, scanned = 0, shardsRead = 0;
  const first = o.startShard ?? 0;
  const last = Math.min(SHARDS[variant], first + (o.maxShards ?? SHARDS[variant]));
  for (let shard = first; shard < last && maps < o.maxMaps; shard++) {
    const key = `${variant}/${shard}`;
    if (state.done.includes(key)) { log(`shard ${shard}: already done, skipping`); continue; }
    log(`shard ${shard}/${SHARDS[variant] - 1}: streaming ${shardUrl(variant, shard)}`);
    const conn = open(variant, shard);
    // json and audio of a sample share a base name; keep what we need until both arrived
    const pending = new Map<string, { json?: { beatmaps: ApiBeatmap[] }; audio?: Buffer; ext?: string }>();
    let stopped = false;
    for await (const { name, data } of readTar(conn.stream)) {
      const dot = name.lastIndexOf('.');
      const base = name.slice(0, dot);
      const ext = name.slice(dot + 1);
      const p = pending.get(base) ?? {};
      if (ext === 'json') {
        let j: { beatmaps: ApiBeatmap[] };
        try {
          // the dataset was written by Python: NaN / Infinity are not valid JSON
          j = JSON.parse(data.toString('utf8').replace(/:\s*(NaN|-?Infinity)(?=\s*[,}\]])/g, ': null'));
        } catch {
          log(`  skipped unreadable sample ${base}`);
          pending.set(base, { json: { beatmaps: [] } });
          continue;
        }
        scanned += j.beatmaps.length;
        p.json = { beatmaps: j.beatmaps.filter((b) => matches(b, o.filter)) };
        if (!p.json.beatmaps.length) p.audio = undefined; // nothing to keep: don't hold the audio
      } else if (!(p.json && !p.json.beatmaps.length)) {
        p.audio = data;
        // the dataset names all original audio .mp3; the compressed variant is .opus
        p.ext = variant === 'compressed' ? 'opus' : ext;
      }
      const skip = !!p.json && !p.json.beatmaps.length;
      const complete = !!p.json && !!p.audio;
      if (skip && ext !== 'json') { pending.delete(base); continue; } // audio of a skipped sample
      if (!complete) { pending.set(base, p); continue; }
      pending.delete(base);
      {
        const json = p.json!;
        const audio = p.audio!;
        const b0 = json.beatmaps[0];
        const dir = join(o.out, safe(`${b0.beatmapset_id} ${b0.artist} - ${b0.title}`));
        if (existsSync(join(dir, 'maniamap-source.json'))) continue; // from an earlier run
        mkdirSync(dir, { recursive: true });
        const audioName = `audio.${p.ext === 'mp3' ? 'mp3' : p.ext}`;
        writeFileSync(join(dir, audioName), audio);
        const source = [];
        for (const b of json.beatmaps) {
          if (maps >= o.maxMaps) break;
          const file = `${safe(b.version)} ${b.beatmap_id}.osu`;
          // point the chart at the saved audio file
          const content = b.content.replace(/^AudioFilename\s*:.*$/m, `AudioFilename: ${audioName}`);
          writeFileSync(join(dir, file), content);
          source.push({
            beatmap_id: b.beatmap_id, beatmapset_id: b.beatmapset_id, file, version: b.version, keys: Math.round(b.diff_size),
            creator: b.creator, creator_id: b.creator_id, approved: b.approved, approved_date: b.approved_date,
            difficultyrating: b.difficultyrating,
          });
          maps++;
        }
        writeFileSync(join(dir, 'maniamap-source.json'), JSON.stringify({ dataset: DATASET, variant, shard, beatmaps: source }, null, 2));
        sets++;
        if (sets % 10 === 0) log(`  ${maps} maps from ${sets} songs so far (${scanned} maps scanned)`);
        if (maps >= o.maxMaps) { stopped = true; break; }
      }
    }
    conn.close();
    shardsRead++;
    if (!stopped) {
      state.done.push(key);
      writeFileSync(statePath, JSON.stringify(state));
    }
  }
  return { maps, sets, shardsRead, scannedMaps: scanned };
}
