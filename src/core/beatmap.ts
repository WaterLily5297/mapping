/**
 * osu!mania beatmap model + .osu (v14) parser / writer.
 *
 * Works for any key count: the key count is stored in [Difficulty] CircleSize,
 * and a note's column is encoded in its x coordinate:
 *     x = floor(column * 512 / keys + 256 / keys)
 *     column = clamp(floor(x * keys / 512), 0, keys - 1)
 *
 * Sections we do not model (Events, Colours, Editor, unknown ones) are kept
 * verbatim so a parse -> write round trip does not lose anything.
 */

export interface Note {
  /** start time in ms */
  time: number;
  /** 0-based column */
  column: number;
  /** end time in ms for long notes (hold notes); undefined for normal notes */
  endTime?: number;
  /** hitsound bitflags (normal=1, whistle=2, finish=4, clap=8) */
  hitSound: number;
  /** raw hitSample string "normalSet:additionSet:index:volume:filename" */
  hitSample: string;
  /** new-combo / combo skip bits that were set in the original type field */
  extraTypeBits: number;
}

export interface TimingPoint {
  time: number;
  /** ms per beat for uninherited points; negative SV multiplier (-100/SV) for inherited */
  beatLength: number;
  meter: number;
  sampleSet: number;
  sampleIndex: number;
  volume: number;
  uninherited: boolean;
  effects: number;
}

export type KV = Map<string, string>;

export interface Beatmap {
  formatVersion: number;
  general: KV;
  editor: KV;
  metadata: KV;
  difficulty: KV;
  /** raw lines of [Events], [Colours] and any unknown section, keyed by section name */
  rawSections: Map<string, string[]>;
  /** order in which sections appeared, so we can write them back in the same order */
  sectionOrder: string[];
  timingPoints: TimingPoint[];
  notes: Note[];
}

const KV_SECTIONS = ['General', 'Editor', 'Metadata', 'Difficulty'] as const;
const DEFAULT_ORDER = [
  'General', 'Editor', 'Metadata', 'Difficulty', 'Events', 'TimingPoints', 'HitObjects',
];

// ---------------------------------------------------------------- helpers

export function columnToX(column: number, keys: number): number {
  return Math.floor((column * 512) / keys + 256 / keys);
}

export function xToColumn(x: number, keys: number): number {
  return Math.min(keys - 1, Math.max(0, Math.floor((x * keys) / 512)));
}

export function getKeys(map: Beatmap): number {
  return Math.round(Number(map.difficulty.get('CircleSize') ?? 4));
}

export function setKeys(map: Beatmap, keys: number): void {
  if (!Number.isInteger(keys) || keys < 1 || keys > 18) {
    throw new Error(`key count must be an integer 1..18 (got ${keys})`);
  }
  map.difficulty.set('CircleSize', String(keys));
}

export function isLN(n: Note): boolean {
  return n.endTime !== undefined && n.endTime > n.time;
}

export function sortNotes(notes: Note[]): Note[] {
  return notes.sort((a, b) => a.time - b.time || a.column - b.column);
}

export function cloneBeatmap(map: Beatmap): Beatmap {
  return {
    formatVersion: map.formatVersion,
    general: new Map(map.general),
    editor: new Map(map.editor),
    metadata: new Map(map.metadata),
    difficulty: new Map(map.difficulty),
    rawSections: new Map([...map.rawSections].map(([k, v]) => [k, [...v]])),
    sectionOrder: [...map.sectionOrder],
    timingPoints: map.timingPoints.map((t) => ({ ...t })),
    notes: map.notes.map((n) => ({ ...n })),
  };
}

export function makeNote(time: number, column: number, endTime?: number): Note {
  return {
    time: Math.round(time),
    column,
    endTime: endTime !== undefined ? Math.round(endTime) : undefined,
    hitSound: 0,
    hitSample: '0:0:0:0:',
    extraTypeBits: 0,
  };
}

/** A fresh, valid, empty mania map. */
export function createBeatmap(opts: {
  keys: number;
  title?: string;
  artist?: string;
  creator?: string;
  version?: string;
  audioFilename?: string;
  bpm?: number;
  offset?: number;
  od?: number;
  hp?: number;
}): Beatmap {
  const map: Beatmap = {
    formatVersion: 14,
    general: new Map([
      ['AudioFilename', opts.audioFilename ?? 'audio.mp3'],
      ['AudioLeadIn', '0'],
      ['PreviewTime', '-1'],
      ['Countdown', '0'],
      ['SampleSet', 'Soft'],
      ['StackLeniency', '0.7'],
      ['Mode', '3'],
      ['LetterboxInBreaks', '0'],
      ['SpecialStyle', '0'],
      ['WidescreenStoryboard', '0'],
    ]),
    editor: new Map([
      ['DistanceSpacing', '1'],
      ['BeatDivisor', '4'],
      ['GridSize', '4'],
      ['TimelineZoom', '1'],
    ]),
    metadata: new Map([
      ['Title', opts.title ?? 'Untitled'],
      ['TitleUnicode', opts.title ?? 'Untitled'],
      ['Artist', opts.artist ?? 'Unknown'],
      ['ArtistUnicode', opts.artist ?? 'Unknown'],
      ['Creator', opts.creator ?? 'maniamap'],
      ['Version', opts.version ?? `${opts.keys}K Normal`],
      ['Source', ''],
      ['Tags', 'maniamap'],
      ['BeatmapID', '0'],
      ['BeatmapSetID', '-1'],
    ]),
    difficulty: new Map([
      ['HPDrainRate', String(opts.hp ?? 8)],
      ['CircleSize', String(opts.keys)],
      ['OverallDifficulty', String(opts.od ?? 8)],
      ['ApproachRate', '5'],
      ['SliderMultiplier', '1.4'],
      ['SliderTickRate', '1'],
    ]),
    rawSections: new Map([['Events', ['//Background and Video events', '//Break Periods', '//Storyboard Layer 0 (Background)', '//Storyboard Layer 1 (Fail)', '//Storyboard Layer 2 (Pass)', '//Storyboard Layer 3 (Foreground)', '//Storyboard Sound Samples']]]),
    sectionOrder: [...DEFAULT_ORDER],
    timingPoints: [],
    notes: [],
  };
  setKeys(map, opts.keys);
  if (opts.bpm) {
    map.timingPoints.push({
      time: Math.round(opts.offset ?? 0),
      beatLength: 60000 / opts.bpm,
      meter: 4,
      sampleSet: 0,
      sampleIndex: 0,
      volume: 70,
      uninherited: true,
      effects: 0,
    });
  }
  return map;
}

// ---------------------------------------------------------------- parse

export function parseOsu(text: string): Beatmap {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const map: Beatmap = {
    formatVersion: 14,
    general: new Map(),
    editor: new Map(),
    metadata: new Map(),
    difficulty: new Map(),
    rawSections: new Map(),
    sectionOrder: [],
    timingPoints: [],
    notes: [],
  };

  let section = '';
  let keys = 4;
  const pendingHitObjects: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const vm = /^osu file format v(\d+)/.exec(line.trim());
    if (vm) {
      map.formatVersion = Number(vm[1]);
      continue;
    }
    const sm = /^\[(\w+)\]\s*$/.exec(line.trim());
    if (sm) {
      section = sm[1];
      if (!map.sectionOrder.includes(section)) map.sectionOrder.push(section);
      continue;
    }
    if (!section) continue;

    if ((KV_SECTIONS as readonly string[]).includes(section)) {
      if (!line.trim() || line.startsWith('//')) continue;
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      const target = sectionKV(map, section);
      target.set(key, value);
      continue;
    }

    if (section === 'TimingPoints') {
      if (!line.trim() || line.startsWith('//')) continue;
      const p = line.split(',');
      const beatLength = Number(p[1]);
      map.timingPoints.push({
        time: Number(p[0]),
        beatLength,
        meter: p[2] !== undefined ? Number(p[2]) : 4,
        sampleSet: p[3] !== undefined ? Number(p[3]) : 0,
        sampleIndex: p[4] !== undefined ? Number(p[4]) : 0,
        volume: p[5] !== undefined ? Number(p[5]) : 100,
        uninherited: p[6] !== undefined ? p[6].trim() === '1' : beatLength > 0,
        effects: p[7] !== undefined ? Number(p[7]) : 0,
      });
      continue;
    }

    if (section === 'HitObjects') {
      if (!line.trim() || line.startsWith('//')) continue;
      pendingHitObjects.push(line);
      continue;
    }

    // Events, Colours, unknown: keep verbatim (drop trailing blank lines later)
    if (!map.rawSections.has(section)) map.rawSections.set(section, []);
    map.rawSections.get(section)!.push(line);
  }

  for (const lines of map.rawSections.values()) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  }

  // the .osu format defaults a missing Mode to 0 (osu!standard)
  const mode = (map.general.get('Mode') ?? '0').trim();
  if (mode !== '3') {
    const names: Record<string, string> = { '0': 'osu!standard', '1': 'osu!taiko', '2': 'osu!catch' };
    throw new Error(`not an osu!mania map (${names[mode] ?? `Mode: ${mode}`}). Only osu!mania (Mode: 3) maps can be opened.`);
  }
  keys = getKeys(map);
  if (!(keys >= 1 && keys <= 18)) throw new Error(`invalid key count CircleSize=${keys}`);

  for (const line of pendingHitObjects) {
    const n = parseHitObject(line, keys);
    if (n) map.notes.push(n);
  }
  sortNotes(map.notes);
  map.timingPoints.sort((a, b) => a.time - b.time || Number(b.uninherited) - Number(a.uninherited));
  return map;
}

function sectionKV(map: Beatmap, section: string): KV {
  switch (section) {
    case 'General': return map.general;
    case 'Editor': return map.editor;
    case 'Metadata': return map.metadata;
    default: return map.difficulty;
  }
}

function parseHitObject(line: string, keys: number): Note | null {
  const p = line.split(',');
  if (p.length < 5) return null;
  const x = Number(p[0]);
  const time = Number(p[2]);
  const type = Number(p[3]);
  const hitSound = Number(p[4]) || 0;
  const isHold = (type & 128) !== 0;
  let endTime: number | undefined;
  let hitSample = '0:0:0:0:';
  const extras = p.slice(5).join(',');
  if (isHold) {
    const colon = extras.indexOf(':');
    endTime = Number(colon >= 0 ? extras.slice(0, colon) : extras);
    hitSample = colon >= 0 ? extras.slice(colon + 1) : '0:0:0:0:';
  } else if (extras) {
    hitSample = extras;
  }
  return {
    time,
    column: xToColumn(x, keys),
    endTime: isHold && Number.isFinite(endTime) ? endTime : undefined,
    hitSound,
    hitSample,
    // keep new-combo (4) and combo-skip (112) bits, drop object-type bits
    extraTypeBits: type & (4 | 112),
  };
}

// ---------------------------------------------------------------- write

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // osu! writes full double precision for beat lengths; trim float noise a bit
  return String(Number(n.toPrecision(15)));
}

export function writeOsu(map: Beatmap): string {
  const keys = getKeys(map);
  const out: string[] = [`osu file format v${map.formatVersion}`, ''];
  const order = [...map.sectionOrder];
  for (const s of DEFAULT_ORDER) if (!order.includes(s)) order.push(s);
  for (const s of map.rawSections.keys()) if (!order.includes(s)) order.push(s);

  for (const section of order) {
    if ((KV_SECTIONS as readonly string[]).includes(section)) {
      const kv = sectionKV(map, section);
      if (!kv.size && section === 'Editor') continue;
      out.push(`[${section}]`);
      const sep = section === 'Metadata' || section === 'Difficulty' ? ':' : ': ';
      for (const [k, v] of kv) out.push(`${k}${sep}${v}`);
      out.push('');
    } else if (section === 'TimingPoints') {
      out.push('[TimingPoints]');
      for (const t of map.timingPoints) {
        out.push([
          fmtNum(t.time), fmtNum(t.beatLength), t.meter, t.sampleSet, t.sampleIndex,
          t.volume, t.uninherited ? 1 : 0, t.effects,
        ].join(','));
      }
      out.push('', '');
    } else if (section === 'HitObjects') {
      out.push('[HitObjects]');
      for (const n of sortNotes([...map.notes])) {
        const x = columnToX(n.column, keys);
        if (isLN(n)) {
          out.push(`${x},192,${Math.round(n.time)},${128 | n.extraTypeBits},${n.hitSound},${Math.round(n.endTime!)}:${n.hitSample}`);
        } else {
          out.push(`${x},192,${Math.round(n.time)},${1 | n.extraTypeBits},${n.hitSound},${n.hitSample}`);
        }
      }
    } else {
      const raw = map.rawSections.get(section);
      if (!raw) continue;
      out.push(`[${section}]`, ...raw, '');
    }
  }
  return out.join('\r\n').replace(/(\r\n)+$/, '') + '\r\n';
}

/** File name osu! uses: "Artist - Title (Creator) [Version].osu", with illegal chars removed. */
export function osuFileName(map: Beatmap): string {
  const m = map.metadata;
  const raw = `${m.get('Artist') ?? ''} - ${m.get('Title') ?? ''} (${m.get('Creator') ?? ''}) [${m.get('Version') ?? ''}].osu`;
  return raw.replace(/[\\/:*?"<>|]/g, '');
}
