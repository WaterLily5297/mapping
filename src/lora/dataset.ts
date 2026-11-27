/**
 * Build a Mapperatorinator "mmrs" dataset from your own osu!mania maps, for LoRA fine-tuning.
 *
 *   <out>/data/<set folder>/<audio>, <diff>.osu ...
 *   <out>/manifest.json      (this file)  -> scripts/lora/build_metadata.py -> <out>/metadata.parquet
 *
 * Every map gets a unique BeatmapID (written into its .osu) and style tags from maniamap's
 * pattern classifier (osu! user tags, the vocabulary Mapperatorinator understands), so the LoRA
 * learns your patterns together with their tags. Node only.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { type Beatmap, getKeys, parseOsu, writeOsu } from '../core/beatmap';
import { classifyPatterns } from '../analysis/patterns';
import { MANIA_DESCRIPTORS } from '../ai/descriptors';
import { convertKeysSmart } from '../tools/keyconvert';
import { lnConvert, type LnPreset } from '../tools/lnconvert';
import { isLN } from '../core/beatmap';

export interface DatasetOptions {
  inputs: string[];
  out: string;
  /** only keep these key counts */
  keys?: number[];
  /** tags added to every map (e.g. your own style tags) */
  extraTags?: string[];
  /** tag maps with maniamap's pattern classifier (default true) */
  autoTags?: boolean;
  /** year to imitate when the source has no date (Mapperatorinator has a year token) */
  year?: number;
  /** also add copies converted to these key counts (clean converter), e.g. [7] */
  convertKeys?: number[];
  /** also add LN-converted copies of rice maps with these presets, e.g. ['hybrid'] */
  lnPresets?: LnPreset[];
  log?: (s: string) => void;
}

export interface ManifestEntry {
  /** 'original' or how the map was made (e.g. 'convert 4K->7K', 'ln hybrid') */
  Source?: string;
  UserId?: number;
  Ranked?: number;
  Id: number;
  BeatmapSetId: number;
  BeatmapSetFolder: string;
  BeatmapFile: string;
  AudioFile: string;
  Keys: number;
  Version: string;
  Creator: string;
  OmdbTags: string[];
  Year: number;
}

interface SetSource { name: string; files: Map<string, () => Uint8Array>; only?: string }

const KNOWN_TAGS = new Set(MANIA_DESCRIPTORS.map((d) => d.tag));
// synthetic IDs far above real osu! IDs, so they never collide with tags the pretrained model knows
const SET_ID_BASE = 1_900_000_000;
const MAP_ID_BASE = 1_950_000_000;

function collect(inputs: string[]): SetSource[] {
  const sets: SetSource[] = [];
  const fromDir = (dir: string, only?: string) => {
    const files = new Map<string, () => Uint8Array>();
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isFile()) files.set(f, () => readFileSync(p));
    }
    sets.push({ name: basename(dir), files, only });
  };
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      const entries = readdirSync(p);
      if (entries.some((f) => f.toLowerCase().endsWith('.osu'))) fromDir(p);
      for (const f of entries) {
        const q = join(p, f);
        if (statSync(q).isDirectory()) walk(q);
        else if (f.toLowerCase().endsWith('.osz')) walk(q);
      }
    } else if (p.toLowerCase().endsWith('.osz')) {
      const z = unzipSync(readFileSync(p));
      const files = new Map<string, () => Uint8Array>();
      for (const [n, data] of Object.entries(z)) if (!n.endsWith('/')) files.set(n, () => data);
      sets.push({ name: basename(p, extname(p)), files });
    } else if (p.toLowerCase().endsWith('.osu')) {
      fromDir(dirname(p), basename(p));
    }
  };
  for (const i of inputs) {
    if (!existsSync(i)) throw new Error(`not found: ${i}`);
    walk(i);
  }
  return sets;
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'set';

export function buildDataset(o: DatasetOptions): ManifestEntry[] {
  const log = o.log ?? (() => {});
  const year = o.year ?? 2023;
  const extra = (o.extraTags ?? []).map((t) => t.trim()).filter(Boolean);
  for (const t of extra) if (!KNOWN_TAGS.has(t)) throw new Error(`unknown style tag "${t}" (see: maniamap ai-status)`);
  if (existsSync(join(o.out, 'data'))) rmSync(join(o.out, 'data'), { recursive: true, force: true });
  mkdirSync(join(o.out, 'data'), { recursive: true });

  const entries: ManifestEntry[] = [];
  let setN = 0;
  let mapN = 0;
  for (const src of collect(o.inputs)) {
    const maps: { file: string; map: Beatmap }[] = [];
    for (const [name, read] of src.files) {
      if (!name.toLowerCase().endsWith('.osu') || (src.only && name !== src.only)) continue;
      let map: Beatmap;
      try { map = parseOsu(strFromU8(read())); } catch { continue; } // not mania / unreadable
      if (o.keys?.length && !o.keys.includes(getKeys(map))) continue;
      if (map.notes.length < 32) continue;
      maps.push({ file: name, map });
    }
    if (!maps.length) continue;
    const audioName = maps[0].map.general.get('AudioFilename') ?? '';
    const audioKey = [...src.files.keys()].find((k) => k.toLowerCase() === audioName.toLowerCase());
    if (!audioKey) { log(`skip ${src.name}: audio "${audioName}" missing`); continue; }

    // metadata from `maniamap data-fetch` (mapper id, date, status), when present
    const sourceInfo = new Map<string, { creator_id?: number; approved?: number; approved_date?: string | null }>();
    const sj = src.files.get('maniamap-source.json');
    if (sj) {
      try {
        for (const b of JSON.parse(Buffer.from(sj()).toString('utf8')).beatmaps ?? []) sourceInfo.set(b.file, b);
      } catch { /* ignore */ }
    }
    // augmentation: converted copies (new IDs; the mapper did not make them, so no mapper id)
    const augmented: { file: string; map: Beatmap; how: string; origin: string }[] = [];
    for (const { file, map } of maps) {
      for (const k of o.convertKeys ?? []) {
        if (k === getKeys(map)) continue;
        const c = convertKeysSmart(map, k, { seed: 1 });
        c.metadata.set('BeatmapID', '0');
        augmented.push({ file: `${basename(file, extname(file))} [${k}K conv].osu`, map: c, how: `convert ${getKeys(map)}K->${k}K`, origin: file });
      }
    }
    for (const base of [...maps.map((m) => ({ ...m, how: 'original', origin: m.file })), ...augmented]) {
      const lnShare = base.map.notes.filter(isLN).length / Math.max(1, base.map.notes.length);
      if (lnShare >= 0.1) continue; // only rice maps get LN copies
      for (const p of o.lnPresets ?? []) {
        const c = lnConvert(base.map, { preset: p, seed: 1 });
        c.metadata.set('BeatmapID', '0');
        augmented.push({ file: `${basename(base.file, extname(base.file))} [LN ${p}].osu`, map: c, how: `${base.how === 'original' ? '' : base.how + ', '}ln ${p}`, origin: base.origin });
      }
    }
    const all = [...maps.map((m) => ({ ...m, how: 'original', origin: m.file })), ...augmented];

    const fileSetId = Number(maps[0].map.metadata.get('BeatmapSetID') ?? -1);
    const setId = fileSetId > 0 ? fileSetId : SET_ID_BASE + ++setN;
    const m0 = maps[0].map.metadata;
    const folder = safe(`${setId} ${m0.get('Artist') ?? ''} - ${m0.get('Title') ?? src.name}`);
    const dir = join(o.out, 'data', folder);
    mkdirSync(dir, { recursive: true });
    const audioFile = safe(basename(audioKey));
    writeFileSync(join(dir, audioFile), src.files.get(audioKey)!());

    for (const { file, map, how, origin } of all) {
      if ((map.general.get('AudioFilename') ?? '').toLowerCase() !== audioName.toLowerCase()) continue; // other song in the folder
      const info = sourceInfo.get(origin);
      const fileId = Number(map.metadata.get('BeatmapID') ?? 0);
      const id = fileId > 0 ? fileId : MAP_ID_BASE + ++mapN;
      map.metadata.set('BeatmapID', String(id));
      map.metadata.set('BeatmapSetID', String(setId));
      map.general.set('AudioFilename', audioFile);
      const tags = new Set(extra);
      if (o.autoTags !== false) {
        for (const t of classifyPatterns(map).suggestedTags) if (KNOWN_TAGS.has(t.tag)) tags.add(t.tag);
      }
      const osuName = safe(basename(file, extname(file))) + '.osu';
      writeFileSync(join(dir, osuName), writeOsu(map));
      entries.push({
        Id: id, BeatmapSetId: setId, BeatmapSetFolder: folder, BeatmapFile: osuName, AudioFile: audioFile,
        Keys: getKeys(map), Version: map.metadata.get('Version') ?? '', Creator: map.metadata.get('Creator') ?? '',
        OmdbTags: [...tags],
        Year: info?.approved_date ? Number(String(info.approved_date).slice(0, 4)) || year : year,
        // a converted copy keeps the era (year) of its original, but it is not the mapper's own work
        UserId: how === 'original' ? info?.creator_id ?? 0 : 0, Ranked: info?.approved ?? 1, Source: how,
      });
      log(`  ${getKeys(map)}K  ${folder}/${osuName}  ${how === 'original' ? '' : `(${how}) `}${[...tags].join(', ')}`);
    }
  }
  writeFileSync(join(o.out, 'manifest.json'), JSON.stringify({ created: new Date().toISOString(), inputs: o.inputs, beatmaps: entries }, null, 2));
  return entries;
}
