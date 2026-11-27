import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import {
  type Beatmap, parseOsu, writeOsu, createBeatmap, getKeys, osuFileName, cloneBeatmap, sortNotes,
} from '../core/beatmap';
import { redLines } from '../core/timing';
import * as T from '../tools/transforms';
import { analyze, analyzeStereo, estimateTempo, type Analysis } from '../automap/analysis';
import { generateFromAnalysis, loudnessForMap, type Difficulty, type StyleChoice, PRESETS } from '../automap/generate';
import { generateForStars } from '../automap/target';
import { starRating } from '../analysis/difficulty';
import { fitDifficulty, rebirthToOfficial } from '../tools/difficultyfit';
import { AudioPlayer } from './audio';
import { initStudio } from './studio';
import { MANIA_DESCRIPTORS } from '../ai/descriptors';
import { Editor, defaultLayout, fmtTime } from './editor';
import { classifyPatterns, notesOfType, summarize, describeTags, PATTERN_INFO, type PatternType } from '../analysis/patterns';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const AUTOSAVE_KEY = 'maniamap.autosave.v1';

const audio = new AudioPlayer();
audio.setVolume(0.6);

/** files of the currently opened .osz (kept so export can re-pack backgrounds etc.) */
let oszFiles: Record<string, Uint8Array> = {};
/** name of the .osu inside the .osz that we are editing */
let currentOsuName = '';
let analysisCache: { key: string; a: Analysis } | null = null;

function status(msg: string) { $('status').textContent = msg; }

function restoreAutosave(): Beatmap | null {
  try {
    const t = localStorage.getItem(AUTOSAVE_KEY);
    return t ? parseOsu(t) : null;
  } catch { return null; }
}
let autosaveTimer = 0;
function autosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    try { localStorage.setItem(AUTOSAVE_KEY, writeOsu(editor.map)); } catch { /* storage unavailable */ }
  }, 800);
}

const restored = restoreAutosave();
const editor = new Editor(
  restored ?? createBeatmap({ keys: 4, bpm: 180, title: 'Untitled' }),
  audio,
  $<HTMLCanvasElement>('field'),
  $<HTMLCanvasElement>('overview'),
);
if (restored) status(`Restored autosaved map (${getKeys(restored)}K, ${restored.notes.length} notes). Open the audio file to continue.`);
editor.onStatus = status;
editor.onChange = () => { refreshUI(); autosave(); schedulePatterns(); };

// ------------------------------------------------------------------ files

async function readFile(f: File): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

function download(name: string, data: Uint8Array | string, type = 'application/octet-stream') {
  const blob = new Blob([typeof data === 'string' ? data : data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function openMapFile(f: File) {
  const bytes = await readFile(f);
  if (f.name.toLowerCase().endsWith('.osz')) {
    oszFiles = unzipSync(bytes);
    const osus = Object.keys(oszFiles).filter((n) => n.toLowerCase().endsWith('.osu'));
    const mania = osus.filter((n) => /^\s*Mode\s*:\s*3/m.test(strFromU8(oszFiles[n])));
    if (!mania.length) { status('This .osz has no osu!mania difficulties (Mode: 3).'); return; }
    const sel = $<HTMLSelectElement>('diff-select');
    sel.innerHTML = '';
    for (const n of mania) {
      const m = /Version\s*:(.*)/.exec(strFromU8(oszFiles[n]));
      const k = /CircleSize\s*:\s*([\d.]+)/.exec(strFromU8(oszFiles[n]));
      sel.add(new Option(`${k ? `${k[1]}K ` : ''}${m ? m[1].trim() : n}`, n));
    }
    sel.hidden = mania.length < 2;
    await loadOsuFromOsz(mania[0]);
  } else {
    oszFiles = {};
    currentOsuName = f.name;
    $<HTMLSelectElement>('diff-select').hidden = true;
    editor.load(parseOsu(strFromU8(bytes)));
    status(`Opened ${f.name}. Now open the audio file "${editor.map.general.get('AudioFilename')}".`);
  }
}

async function loadOsuFromOsz(name: string) {
  currentOsuName = name;
  const map = parseOsu(strFromU8(oszFiles[name]));
  editor.load(map);
  const audioName = map.general.get('AudioFilename') ?? '';
  const key = Object.keys(oszFiles).find((n) => n.toLowerCase() === audioName.toLowerCase());
  if (key && audio.fileName !== key) {
    status(`Loading audio ${key}…`);
    await audio.load(oszFiles[key], key);
    analysisCache = null;
  }
  status(`Opened ${name} (${getKeys(map)}K, ${map.notes.length} notes)`);
}

$<HTMLInputElement>('open-map').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try { await openMapFile(f); } catch (err) { status(`Error: ${(err as Error).message}`); }
  (e.target as HTMLInputElement).value = '';
});

$<HTMLSelectElement>('diff-select').addEventListener('change', (e) => {
  void loadOsuFromOsz((e.target as HTMLSelectElement).value);
});

$<HTMLInputElement>('open-audio').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  status(`Loading ${f.name}…`);
  await audio.load(await readFile(f), f.name);
  analysisCache = null;
  if (editor.map.general.get('AudioFilename') !== f.name) {
    const next = cloneBeatmap(editor.map);
    next.general.set('AudioFilename', f.name);
    editor.commit(next, 'audio set');
  }
  status(`Audio ${f.name} loaded (${fmtTime(audio.durationMs)})`);
  (e.target as HTMLInputElement).value = '';
});
audio.onLoaded = () => refreshUI();

function saveOsu() {
  download(osuFileName(editor.map), writeOsu(editor.map), 'text/plain');
  status(`Saved ${osuFileName(editor.map)}`);
}
$('save-osu').addEventListener('click', saveOsu);
window.addEventListener('keydown', (e) => {
  if (editor.active && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveOsu(); }
});

$('export-osz').addEventListener('click', () => {
  const files: Record<string, Uint8Array> = { ...oszFiles };
  if (currentOsuName && files[currentOsuName]) delete files[currentOsuName];
  files[osuFileName(editor.map)] = strToU8(writeOsu(editor.map));
  const audioName = editor.map.general.get('AudioFilename') ?? '';
  if (audio.bytes && audioName && !files[audioName]) files[audioName] = audio.bytes;
  if (!audio.bytes && !oszFiles[audioName]) status('Warning: no audio loaded, so the .osz has no audio file.');
  const m = editor.map.metadata;
  download(`${m.get('Artist')} - ${m.get('Title')}.osz`.replace(/[\\/:*?"<>|]/g, ''), zipSync(files, { level: 6 }));
});

// ------------------------------------------------------------------ top bar

$('play').addEventListener('click', () => void audio.toggle());
$<HTMLSelectElement>('rate').addEventListener('change', (e) => audio.setRate(Number((e.target as HTMLSelectElement).value)));
$<HTMLInputElement>('volume').addEventListener('input', (e) => audio.setVolume(Number((e.target as HTMLInputElement).value)));
$<HTMLSelectElement>('divisor').addEventListener('change', (e) => { editor.divisor = Number((e.target as HTMLSelectElement).value); refreshUI(); });
$$('#modes button').forEach((b) => b.addEventListener('click', () => { editor.mode = b.dataset.mode as typeof editor.mode; refreshUI(); }));
$('live').addEventListener('click', () => { editor.live = !editor.live; refreshUI(); status(editor.live ? `Live mapping ON. Keys: ${editor.layout}` : 'Live mapping off'); });
$('undo').addEventListener('click', () => editor.undo());
$('redo').addEventListener('click', () => editor.redo());
$<HTMLInputElement>('snapcolor').addEventListener('change', (e) => { editor.colorBySnap = (e.target as HTMLInputElement).checked; });
$<HTMLInputElement>('wave').addEventListener('change', (e) => { editor.showWaveform = (e.target as HTMLInputElement).checked; });
$<HTMLInputElement>('ticks').addEventListener('change', (e) => { editor.hitTicks = (e.target as HTMLInputElement).checked; });
audio.el.addEventListener('play', () => { $('play').textContent = '❚❚'; });
audio.el.addEventListener('pause', () => { $('play').textContent = '▶'; });

// ------------------------------------------------------------------ tabs

$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('section[data-panel]').forEach((s) => { s.hidden = s.dataset.panel !== b.dataset.tab; });
  if (b.dataset.tab === 'check') renderCheck();
  if (b.dataset.tab === 'tools') renderStarsNow();
  if (b.dataset.tab === 'patterns') runPatterns();
}));

// ------------------------------------------------------------------ song panel

const META_FIELDS = ['Title', 'TitleUnicode', 'Artist', 'ArtistUnicode', 'Creator', 'Version', 'Source', 'Tags'];
const DIFF_FIELDS: [string, string][] = [['HPDrainRate', 'HP'], ['OverallDifficulty', 'OD']];

function renderSongForms() {
  const mf = $('meta-form');
  mf.innerHTML = '';
  for (const f of META_FIELDS) {
    const l = document.createElement('label');
    l.textContent = f;
    const i = document.createElement('input');
    i.value = editor.map.metadata.get(f) ?? '';
    i.addEventListener('change', () => {
      const next = cloneBeatmap(editor.map);
      next.metadata.set(f, i.value);
      editor.commit(next, `${f} changed`);
    });
    l.append(i);
    mf.append(l);
  }
  const df = $('diff-form');
  df.innerHTML = '';
  const kl = document.createElement('label');
  kl.innerHTML = `Keys <input value="${getKeys(editor.map)}K" disabled />`;
  df.append(kl);
  for (const [key, name] of DIFF_FIELDS) {
    const l = document.createElement('label');
    l.textContent = name;
    const i = document.createElement('input');
    i.type = 'number'; i.step = '0.1'; i.min = '0'; i.max = '10';
    i.value = editor.map.difficulty.get(key) ?? '8';
    i.addEventListener('change', () => {
      const next = cloneBeatmap(editor.map);
      next.difficulty.set(key, String(Math.max(0, Math.min(10, Number(i.value)))));
      editor.commit(next, `${name} changed`);
    });
    l.append(i);
    df.append(l);
  }
}

$('new-map').addEventListener('click', () => {
  const keys = Number($<HTMLInputElement>('new-keys').value);
  if (!(keys >= 1 && keys <= 18)) { status('Keys must be 1..18'); return; }
  if (editor.map.notes.length && !confirm('Replace the current map with an empty one? (Ctrl+Z to undo)')) return;
  const bpm = redLines(editor.map)[0];
  const next = createBeatmap({
    keys,
    title: editor.map.metadata.get('Title'),
    artist: editor.map.metadata.get('Artist'),
    audioFilename: audio.fileName || editor.map.general.get('AudioFilename'),
    bpm: bpm ? 60000 / bpm.beatLength : 180,
    offset: bpm?.time ?? 0,
  });
  editor.commit(next, `new ${keys}K map`);
  editor.layout = defaultLayout(keys);
});

$('set-preview').addEventListener('click', () => {
  const next = cloneBeatmap(editor.map);
  next.general.set('PreviewTime', String(Math.round(audio.now())));
  editor.commit(next, 'preview point set');
});

// ------------------------------------------------------------------ timing panel

function renderTiming() {
  const list = $('tp-list');
  list.innerHTML = '';
  editor.map.timingPoints.forEach((tp, idx) => {
    const d = document.createElement('div');
    d.className = `item ${tp.uninherited ? 'red' : 'green'}`;
    const label = tp.uninherited
      ? `${+(60000 / tp.beatLength).toFixed(3)} BPM  ${tp.meter}/4`
      : `SV ${(-100 / tp.beatLength).toFixed(2)}×`;
    d.innerHTML = `<span class="grow">${fmtTime(tp.time)} <span class="muted">(${Math.round(tp.time)})</span> — ${label}</span>`;
    const nudge = (ms: number) => {
      const next = cloneBeatmap(editor.map);
      next.timingPoints[idx].time += ms;
      editor.commit(next, `timing point moved ${ms > 0 ? '+' : ''}${ms}ms`);
    };
    for (const [txt, ms] of [['−1', -1], ['+1', 1]] as const) {
      const b = document.createElement('button');
      b.textContent = txt;
      b.title = `move ${ms}ms`;
      b.addEventListener('click', (e) => { e.stopPropagation(); nudge(ms); });
      d.append(b);
    }
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'delete';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = cloneBeatmap(editor.map);
      next.timingPoints.splice(idx, 1);
      editor.commit(next, 'timing point deleted');
    });
    d.append(del);
    d.addEventListener('click', () => editor.seek(tp.time));
    list.append(d);
  });
}

function addTimingPoint(uninherited: boolean) {
  const next = cloneBeatmap(editor.map);
  const t = Math.round(audio.now());
  const val = uninherited ? Number($<HTMLInputElement>('tp-bpm').value) : Number($<HTMLInputElement>('tp-sv').value);
  if (!(val > 0)) { status('Enter a positive value'); return; }
  next.timingPoints = next.timingPoints.filter((p) => !(p.time === t && p.uninherited === uninherited));
  next.timingPoints.push({
    time: t,
    beatLength: uninherited ? 60000 / val : -100 / val,
    meter: Number($<HTMLInputElement>('tp-meter').value) || 4,
    sampleSet: 0, sampleIndex: 0, volume: 70, uninherited, effects: 0,
  });
  next.timingPoints.sort((a, b) => a.time - b.time || Number(b.uninherited) - Number(a.uninherited));
  editor.commit(next, uninherited ? `red line ${val} BPM at ${t}ms` : `SV ${val}× at ${t}ms`);
}
$('add-red').addEventListener('click', () => addTimingPoint(true));
function scaleBpm(f: number) {
  const next = cloneBeatmap(editor.map);
  const reds = next.timingPoints.filter((t) => t.uninherited);
  if (!reds.length) { status('No red line to change.'); return; }
  for (const t of reds) t.beatLength /= f;
  editor.commit(next, `BPM ${f > 1 ? '×2' : '÷2'}: now ${reds.map((t) => +(60000 / t.beatLength).toFixed(2)).join(', ')} BPM`);
}
$('bpm-x2').addEventListener('click', () => scaleBpm(2));
$('bpm-half').addEventListener('click', () => scaleBpm(0.5));
$('add-green').addEventListener('click', () => addTimingPoint(false));

const taps: number[] = [];
function tap() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now);
  if (taps.length >= 4) {
    const bpm = (60000 * (taps.length - 1)) / (taps[taps.length - 1] - taps[0]);
    $('tap-out').textContent = `${bpm.toFixed(2)} BPM (${taps.length} taps)`;
    $<HTMLInputElement>('tp-bpm').value = bpm.toFixed(2);
  } else $('tap-out').textContent = `${taps.length} taps…`;
}
$('tap').addEventListener('click', tap);
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (editor.active && e.key.toLowerCase() === 't' && !e.ctrlKey && !editor.live && tag !== 'INPUT' && !$('tp-list').closest('section')!.hidden) tap();
});

function getAnalysis(): Analysis | null {
  if (!audio.samples) { status('Load an audio file first.'); return null; }
  const key = `${audio.fileName}:${audio.samples.length}`;
  if (analysisCache?.key !== key) {
    status('Analysing audio…');
    analysisCache = { key, a: audio.stereo ? analyzeStereo(audio.stereo[0], audio.stereo[1], AudioPlayer.ANALYSIS_RATE) : analyze(audio.samples, AudioPlayer.ANALYSIS_RATE) };
  }
  return analysisCache.a;
}

$('detect-bpm').addEventListener('click', () => {
  status('Detecting tempo…');
  setTimeout(() => {
    const a = getAnalysis();
    if (!a) return;
    const t = estimateTempo(a);
    const beat = 60000 / t.bpm;
    let offset = t.offset % beat;
    if (offset < 0) offset += beat;
    const next = cloneBeatmap(editor.map);
    next.timingPoints = next.timingPoints.filter((p) => !p.uninherited);
    next.timingPoints.unshift({
      time: Math.round(offset), beatLength: beat, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 70, uninherited: true, effects: 0,
    });
    next.timingPoints.sort((x, y) => x.time - y.time || Number(y.uninherited) - Number(x.uninherited));
    editor.commit(next, `Detected ${t.bpm} BPM, offset ${Math.round(offset)}ms. Check it with hit ticks; adjust the offset with ±1, or use BPM ×2 / ÷2 for half- or double-time songs.`);
    $<HTMLInputElement>('tp-bpm').value = String(t.bpm);
  }, 20);
});

// ------------------------------------------------------------------ tools panel

const lnOpts = () => ({
  gapBeats: Number($<HTMLInputElement>('ln-gap').value) || 0.25,
  maxBeats: Number($<HTMLInputElement>('ln-max').value) || 0,
});

const TOOLS: Record<string, [string, (m: Beatmap) => Beatmap]> = {
  mirror: ['Mirror', T.mirror],
  permute: ['Shuffle columns', (m) => T.permuteColumns(m, Date.now())],
  randomize: ['Randomize', (m) => T.randomize(m, Date.now())],
  fix: ['Remove overlaps', T.fixOverlaps],
  fullln: ['Full LN', (m) => T.fullLN(m, lnOpts())],
  inverse: ['Inverse LN', (m) => T.inverseLN(m, { ...lnOpts(), gapBeats: Math.min(lnOpts().gapBeats, 0.125) })],
  noln: ['LN → rice', T.removeLNs],
  quantize: ['Quantize', (m) => T.quantize(m, Number($<HTMLInputElement>('q-div').value) || 4)],
};
$$('[data-tool]').forEach((b) => b.addEventListener('click', () => {
  const [label, fn] = TOOLS[b.dataset.tool!];
  editor.applyTool(label, fn);
}));

$('conv').addEventListener('click', () => {
  const k = Number($<HTMLInputElement>('conv-keys').value);
  if (!(k >= 1 && k <= 18)) { status('Keys must be 1..18'); return; }
  const before = editor.map.notes.length;
  const out = T.convertKeys(editor.map, k, {
    seed: Number($<HTMLInputElement>('conv-seed').value) || 1,
    fill: Number($<HTMLInputElement>('conv-fill').value), spreadJacks: $<HTMLInputElement>('conv-spread').checked,
  });
  editor.commit(out, `Converted ${getKeys(editor.map)}K → ${k}K (${before} → ${out.notes.length} notes). ${dirtNote(editor.map, out)}`);
});

/** short "clean check" for the status bar */
function dirtNote(before: Beatmap, after: Beatmap): string {
  const b = T.dirt(before);
  const d = T.dirt(after);
  return `Clean check: fast jacks ${b.fastJacks.toFixed(0)}→${d.fastJacks.toFixed(0)}, tight LN releases ${b.tightReleases.toFixed(0)}→${d.tightReleases.toFixed(0)}, dirt ${b.score.toFixed(0)}→${d.score.toFixed(0)} (per 1000 notes).`;
}

for (const id of ['conv-fill', 'lnc-short', 'lnc-long', 'lnc-level']) {
  const i = $<HTMLInputElement>(id);
  const show = () => { (i.nextElementSibling as HTMLElement).textContent = Number(i.value).toFixed(2); };
  i.addEventListener('input', show);
  show();
}
$<HTMLSelectElement>('lnc-preset').addEventListener('change', (e) => {
  const p = T.LN_PRESETS[(e.target as HTMLSelectElement).value as T.LnPreset];
  $<HTMLInputElement>('lnc-short').value = String(p.short!.ratio);
  $<HTMLInputElement>('lnc-long').value = String(p.long!.ratio);
  $<HTMLInputElement>('lnc-level').value = String(p.long!.level);
  ['lnc-short', 'lnc-long', 'lnc-level'].forEach((id) => $(id).dispatchEvent(new Event('input')));
});
$('lnc-run').addEventListener('click', () => {
  const preset = $<HTMLSelectElement>('lnc-preset').value as T.LnPreset;
  const level = Number($<HTMLInputElement>('lnc-level').value);
  const before = editor.map;
  editor.applyTool(`LN converter (${preset})`, (m) => T.lnConvert(m, {
    preset,
    short: { ratio: Number($<HTMLInputElement>('lnc-short').value), level: Math.min(level, T.LN_PRESETS[preset].short!.level / T.LN_PRESETS[preset].long!.level * level) },
    long: { ratio: Number($<HTMLInputElement>('lnc-long').value), level },
    seed: Date.now() % 100000,
  }));
  status(`LN converter (${preset}) applied. ${dirtNote(before, editor.map)}`);
});

function renderStarsNow() {
  const el = $('sr-now');
  if (!editor.map.notes.length) { el.textContent = 'no notes yet'; return; }
  const st = starRating(editor.map).stars;
  const ln = editor.map.notes.filter((n) => n.endTime !== undefined).length / editor.map.notes.length;
  el.textContent = `now ${st.toFixed(2)}★ (Rebirth) ~ ${rebirthToOfficial(st, ln).toFixed(2)}★ osu!`;
}
$('sr-adjust').addEventListener('click', () => {
  const target = Number($<HTMLInputElement>('sr-target').value);
  if (!(target > 0) || !editor.map.notes.length) return;
  status('adjusting difficulty…');
  setTimeout(() => {
    const before = editor.map;
    // contrast-aware when audio is loaded (and already analysed or quick to analyse)
    const an = audio.samples ? getAnalysis() : null;
    const r = fitDifficulty(before, target, { allowJacks: $<HTMLInputElement>('sr-jacks').checked, seed: Date.now() % 100000, ...(an ? { loudness: loudnessForMap(an, before) } : {}) });
    const what = r.removed ? `removed ${r.removed} notes` : r.added ? `added ${r.added} notes` : 'no change';
    const miss = r.reached ? '' : r.stars < target ? ' — no room for more clean notes (try allowing chord jacks, or a rate change)' : '';
    editor.commit(r.map, `Difficulty ${r.startStars.toFixed(2)}★ → ${r.stars.toFixed(2)}★ (target ${target}), ${what}${miss}. ${dirtNote(before, r.map)}`);
    renderStarsNow();
  }, 20);
});

$('rate-apply').addEventListener('click', () => {
  const r = Number($<HTMLInputElement>('rate-x').value);
  if (!(r > 0)) return;
  editor.commit(T.changeRate(editor.map, r), `Rate ${r}× applied to the chart`);
});

// ------------------------------------------------------------------ auto-map panel

for (const id of ['am-density', 'am-ln', 'am-pitch']) {
  const i = $<HTMLInputElement>(id);
  const show = () => { (i.nextElementSibling as HTMLElement).textContent = Number(i.value).toFixed(2); };
  i.addEventListener('input', show);
  show();
}
$<HTMLInputElement>('am-stars').addEventListener('input', (e) => {
  const on = !!(e.target as HTMLInputElement).value;
  for (const id of ['am-diff', 'am-density']) $<HTMLInputElement>(id).disabled = on;
});
$<HTMLSelectElement>('am-diff').addEventListener('change', (e) => {
  const p = PRESETS[(e.target as HTMLSelectElement).value as Difficulty];
  $<HTMLInputElement>('am-density').value = String(p.density);
  $<HTMLInputElement>('am-ln').value = String(p.lnRatio);
  ['am-density', 'am-ln'].forEach((id) => $(id).dispatchEvent(new Event('input')));
});

function renderRange() {
  const a = editor.rangeA, b = editor.rangeB;
  $('range-out').textContent = a === null && b === null ? 'whole song'
    : `${a === null ? 'start' : fmtTime(a)} → ${b === null ? 'end' : fmtTime(b)}`;
}
$('range-a').addEventListener('click', () => { editor.rangeA = Math.round(audio.now()); renderRange(); });
$('range-b').addEventListener('click', () => { editor.rangeB = Math.round(audio.now()); renderRange(); });
$('range-clear').addEventListener('click', () => { editor.rangeA = editor.rangeB = null; renderRange(); });

let engine: 'builtin' | 'ai' = 'builtin';

$('am-run').addEventListener('click', () => {
  if (engine === 'ai') { void runAiMap(); return; }
  $('am-status').textContent = 'working…';
  setTimeout(() => {
    try { runAutoMap(); } catch (e) { status(`Auto-map failed: ${(e as Error).message}`); }
    $('am-status').textContent = '';
  }, 20);
});

function runAutoMap() {
  const a = getAnalysis();
  if (!a) return;
  const keys = Number($<HTMLInputElement>('am-keys').value);
  if (!(keys >= 1 && keys <= 18)) { status('Keys must be 1..18'); return; }
  const red = redLines(editor.map)[0];
  const useTiming = $<HTMLInputElement>('am-timing').checked && !!red;
  const chordV = $<HTMLInputElement>('am-chord').value;
  const divV = $<HTMLSelectElement>('am-div').value;
  const targetV = $<HTMLInputElement>('am-stars').value;
  const base = {
    keys,
    style: $<HTMLSelectElement>('am-style').value as StyleChoice,
    difficulty: $<HTMLSelectElement>('am-diff').value as Difficulty,
    density: Number($<HTMLInputElement>('am-density').value),
    lnRatio: Number($<HTMLInputElement>('am-ln').value),
    pitchFollow: Number($<HTMLInputElement>('am-pitch').value),
    maxChord: chordV ? Number(chordV) : undefined,
    divisor: divV ? Number(divV) : undefined,
    seed: Number($<HTMLInputElement>('am-seed').value) || 1,
    bpm: useTiming ? 60000 / red.beatLength : undefined,
    offset: useTiming ? red.time : undefined,
  };
  if (targetV) {
    const target = Number(targetV);
    const r = generateForStars(a, { ...base, difficulty: undefined, density: undefined, targetStars: target });
    r.map.metadata.set('Version', `${keys}K ${r.stars.toFixed(1)}* (auto)`);
    const note = r.reached ? '' : r.stars < target ? ` (this song tops out around ${r.stars.toFixed(1)}★ at ${keys}K without dirty jacks)` : '';
    applyGenerated(r.map, keys, useTiming, `Auto-mapped to ${r.stars.toFixed(2)}★ (target ${target}${note})`);
    return;
  }
  applyGenerated(generateFromAnalysis(a, base), keys, useTiming, 'Auto-mapped');
}

/** The auto-map range in ms, or null for the whole song. */
function mapRange(): { lo: number; hi: number } | null {
  if (editor.rangeA === null && editor.rangeB === null) return null;
  return {
    lo: Math.min(editor.rangeA ?? 0, editor.rangeB ?? Infinity),
    hi: Math.max(editor.rangeA ?? 0, editor.rangeB ?? Infinity),
  };
}

/** Put a generated map into the editor: replace everything, or only the notes inside the range. */
function applyGenerated(gen: Beatmap, keys: number, keepTiming: boolean, label: string): boolean {
  const range = mapRange();
  const curKeys = getKeys(editor.map);
  const next = cloneBeatmap(editor.map);

  if (range) {
    if (keys !== curKeys) { status(`Range auto-map needs the same key count as the map (${curKeys}K).`); return false; }
    const { lo, hi } = range;
    const inR = (t: number) => t >= lo && t <= hi;
    if (!keepTiming) next.timingPoints = [...gen.timingPoints, ...next.timingPoints.filter((p) => !p.uninherited)];
    next.notes = sortNotes([
      ...next.notes.filter((n) => !inR(n.time)),
      ...gen.notes.filter((n) => inR(n.time) && (n.endTime === undefined || n.endTime <= hi)).map((n) => ({ ...n })),
    ]);
    editor.commit(T.fixOverlaps(next), `${label} ${fmtTime(lo)}–${Number.isFinite(hi) ? fmtTime(hi) : 'end'}`);
    return true;
  }

  if (editor.map.notes.length && !confirm(`Replace all ${editor.map.notes.length} notes with the generated ${keys}K chart? (Ctrl+Z to undo)`)) return false;
  next.difficulty = new Map(gen.difficulty);
  next.notes = gen.notes.map((n) => ({ ...n }));
  if (!keepTiming) next.timingPoints = gen.timingPoints.map((t) => ({ ...t }));
  if (keys !== curKeys) {
    const v = next.metadata.get('Version') ?? '';
    next.metadata.set('Version', /\b\d+K\b/i.test(v) ? v.replace(/\b\d+K\b/i, `${keys}K`) : gen.metadata.get('Version')!);
    editor.layout = defaultLayout(keys);
  }
  if (audio.fileName) next.general.set('AudioFilename', audio.fileName);
  const tags = new Set([...(next.metadata.get('Tags') ?? '').split(/\s+/), ...(gen.metadata.get('Tags') ?? '').split(/\s+/)].filter(Boolean));
  next.metadata.set('Tags', [...tags].join(' '));
  const s = T.stats(next);
  editor.commit(next, `${label} ${keys}K: ${s.notes} notes (${s.lns} LN), ${s.mainBpm} BPM, avg ${s.avgNps.toFixed(1)} NPS. Edit it by hand from here.`);
  return true;
}

// ------------------------------------------------------------------ AI engine (Mapperatorinator via the local server)

const API_HEADERS = { 'x-maniamap': '1', 'content-type': 'application/json' };
let aiJobId: string | null = null;

for (const d of MANIA_DESCRIPTORS) {
  const l = document.createElement('label');
  l.title = d.group;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = d.tag;
  l.append(box, d.tag);
  $('ai-tags').append(l);
}
for (const id of ['ai-ln', 'ai-cfg']) {
  const i = $<HTMLInputElement>(id);
  const show = () => { (i.nextElementSibling as HTMLElement).textContent = Number(i.value).toFixed(2); };
  i.addEventListener('input', show);
  show();
}

async function checkAi(): Promise<boolean> {
  const out = $('ai-avail');
  try {
    const r = await fetch('api/ai/status', { headers: API_HEADERS });
    if (!r.ok) throw new Error(String(r.status));
    const s = await r.json();
    out.textContent = s.available ? `Mapperatorinator ready (${s.dir}).` : s.problem;
    // LoRAs trained with `maniamap lora-train`
    const sel = $<HTMLSelectElement>('ai-lora');
    const keep = sel.value;
    sel.length = 1;
    for (const l of (s.loras ?? []) as { name: string; info: { beatmaps?: number; keys?: number[] } }[]) {
      const k = l.info.keys?.length ? ` · ${l.info.keys.join('/')}K` : '';
      sel.add(new Option(`${l.name}${k}${l.info.beatmaps ? ` · ${l.info.beatmaps} maps` : ''}`, l.name));
    }
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
    return !!s.available;
  } catch {
    out.textContent = 'The AI engine needs the local server: start the editor with "maniamap editor".';
    return false;
  }
}

$$('#am-engine button').forEach((b) => b.addEventListener('click', () => {
  engine = b.dataset.engine as typeof engine;
  $$('#am-engine button').forEach((x) => x.classList.toggle('on', x === b));
  $('am-builtin').hidden = engine !== 'builtin';
  $('am-ai').hidden = engine !== 'ai';
  $('am-engine-help').textContent = engine === 'ai'
    ? 'Mapperatorinator (OliBomby, MIT) is an AI trained on ranked maps. It runs on your computer through "maniamap editor"; on a CPU a 1-minute song takes a few minutes. Always disclose AI use when you share a map.'
    : 'Creates notes from the loaded audio using onset detection, beat-grid snapping, pitch-to-column mapping and pattern rules. Works for any key count.';
  if (engine === 'ai') void checkAi();
}));

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

async function runAiMap() {
  if (aiJobId) return;
  if (!audio.bytes) { status('Load an audio file first.'); return; }
  const keys = Number($<HTMLInputElement>('am-keys').value);
  if (!(keys >= 1 && keys <= 18)) { status('Keys must be 1..18'); return; }
  if (!(await checkAi())) { status($('ai-avail').textContent ?? 'AI engine not available'); return; }
  const red = redLines(editor.map)[0];
  const useTiming = $<HTMLInputElement>('ai-timing').checked && !!red;
  const tags = $$('#ai-tags input').filter((i) => (i as HTMLInputElement).checked).map((i) => (i as HTMLInputElement).value);
  const range = mapRange();
  const seedV = $<HTMLInputElement>('ai-seed').value;
  const body = {
    audioBase64: toBase64(audio.bytes), audioName: audio.fileName || 'audio.mp3', keys,
    stars: Number($<HTMLInputElement>('ai-stars').value), fit: $<HTMLInputElement>('ai-fit').checked, ln: Number($<HTMLInputElement>('ai-ln').value), sv: 0,
    tags, year: Number($<HTMLInputElement>('ai-year').value), cfg: tags.length ? Number($<HTMLInputElement>('ai-cfg').value) : 1,
    seed: seedV ? Number(seedV) : undefined, device: $<HTMLSelectElement>('ai-device').value,
    lora: $<HTMLSelectElement>('ai-lora').value || undefined,
    timingOsu: useTiming ? writeOsu(editor.map) : undefined,
    start: range ? range.lo : undefined,
    end: range && Number.isFinite(range.hi) ? range.hi : undefined,
    title: editor.map.metadata.get('Title'), artist: editor.map.metadata.get('Artist'),
  };
  const r = await fetch('api/ai/jobs', { method: 'POST', headers: API_HEADERS, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { status(`AI: ${j.error}`); return; }
  aiJobId = j.id;
  $('ai-cancel').hidden = false;
  $<HTMLButtonElement>('am-run').disabled = true;
  $('ai-progress').hidden = false;
  $('ai-check').innerHTML = '';
  status(`AI generating ${keys}K${tags.length ? ` (${tags.join(', ')})` : ''}…`);
  const poll = async () => {
    if (!aiJobId) return;
    let s;
    try { s = await (await fetch(`api/ai/jobs/${aiJobId}`, { headers: API_HEADERS })).json(); } catch { setTimeout(poll, 2000); return; }
    $('ai-progress').textContent = `${s.seconds}s\n${(s.log ?? []).slice(-8).join('\n')}`;
    $('am-status').textContent = s.state === 'running' ? `${s.seconds}s…` : '';
    if (s.state === 'running') { setTimeout(poll, 1500); return; }
    aiJobId = null;
    $('ai-cancel').hidden = true;
    $<HTMLButtonElement>('am-run').disabled = false;
    if (s.state !== 'done') { status(`AI ${s.state}: ${(s.error ?? '').split('\n')[0]}`); return; }
    const gen = parseOsu(s.osu);
    const starNote = s.stars !== undefined ? ` ${Number(s.stars).toFixed(2)}★${s.fitFrom !== undefined ? ` (adjusted from ${Number(s.fitFrom).toFixed(2)}★)` : ''}` : '';
    if (applyGenerated(gen, keys, useTiming, `AI-mapped${starNote}`)) {
      const check = $('ai-check');
      check.innerHTML = '';
      for (const c of (s.styleCheck ?? []) as { tag: string; matched: boolean; score?: number }[]) {
        const d = document.createElement('div');
        d.className = `tag ${c.matched ? 'ok' : 'miss'}`;
        d.innerHTML = `<code></code><span class="score">${c.score !== undefined ? c.score.toFixed(2) : ''}</span><span class="why">${c.matched ? 'found in the generated map' : 'not clearly found: try a higher style strength or another seed'}</span>`;
        d.querySelector('code')!.textContent = c.tag;
        check.append(d);
      }
      $('ai-progress').hidden = true;
    }
  };
  setTimeout(poll, 1000);
}

$('ai-cancel').addEventListener('click', async () => {
  if (!aiJobId) return;
  await fetch(`api/ai/jobs/${aiJobId}`, { method: 'DELETE', headers: API_HEADERS }).catch(() => undefined);
});

// ------------------------------------------------------------------ check panel

function renderCheck() {
  const s = T.stats(editor.map);
  $('stats').textContent = [
    `${s.keys}K  ·  ${s.mainBpm} BPM  ·  OD ${editor.map.difficulty.get('OverallDifficulty')}  ·  HP ${editor.map.difficulty.get('HPDrainRate')}`,
    `notes ${s.notes}   rice ${s.rice}   LN ${s.lns} (${s.lnPercent.toFixed(1)}%)`,
    `length ${fmtTime(s.lastTime)}   drain ${s.drainSeconds.toFixed(0)}s`,
    `NPS avg ${s.avgNps.toFixed(2)}   peak ${s.peakNps}`,
    ...(s.notes ? [(() => { const st = starRating(editor.map).stars; return `stars ${st.toFixed(2)} (Rebirth)  ~ ${rebirthToOfficial(st, s.lnPercent / 100).toFixed(2)} osu!`; })()] : []),
    `jacks ${s.jacks}`,
    `per column  ${s.columnCounts.join(' · ')}`,
    `chords      ${s.chordSizes.map((c, i) => (c ? `${i + 1}:${c}` : '')).filter(Boolean).join('  ')}`,
  ].join('\n');
  const list = $('issues');
  list.innerHTML = '';
  const issues = T.validate(editor.map);
  if (!issues.length) list.innerHTML = '<div class="muted">No problems found.</div>';
  for (const i of issues.slice(0, 500)) {
    const d = document.createElement('div');
    d.className = `item ${i.severity}`;
    d.innerHTML = `<span>${fmtTime(i.time)}</span><span class="muted">${i.column !== undefined ? `col ${i.column + 1}` : ''}</span><span class="grow">${i.message}</span>`;
    d.addEventListener('click', () => {
      editor.seek(i.time);
      editor.selected = new Set(editor.map.notes.filter((n) => n.time === i.time && (i.column === undefined || n.column === i.column)));
    });
    list.append(d);
  }
}
$('check-run').addEventListener('click', renderCheck);

// ------------------------------------------------------------------ patterns panel

const ALL_TYPES = Object.keys(PATTERN_INFO) as PatternType[];
for (const t of ALL_TYPES) {
  $<HTMLSelectElement>('pat-type').add(new Option(PATTERN_INFO[t].name, t));
  $<HTMLSelectElement>('pat-filter').add(new Option(PATTERN_INFO[t].name, t));
}

let patternTimer = 0;
const BIG_MAP = 15000;
let bigMapNotified = false;
function schedulePatterns() {
  if (!$<HTMLInputElement>('pat-auto').checked) return;
  // big maps: analysing on every edit would make editing stutter, so switch it off once
  if (editor.map.notes.length > BIG_MAP) {
    if (!bigMapNotified) {
      bigMapNotified = true;
      $<HTMLInputElement>('pat-auto').checked = false;
      status(`Large map (${editor.map.notes.length} notes): pattern analysis now runs only when you press Analyse.`);
    }
    return;
  }
  clearTimeout(patternTimer);
  patternTimer = window.setTimeout(runPatterns, 400);
}

function esc(s: string) { return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`); }

function runPatterns() {
  const r = classifyPatterns(editor.map);
  editor.patterns = r;
  $('pat-summary').textContent = r.sections.length
    ? `${r.keys}K · ${r.sections.length} sections · ${summarize(r, 3)}`
    : 'No notes to analyse.';

  const slotName = { RC: 'Rice', LN: 'LN', HB: 'Hybrid', SV: 'SV' }[r.slot];
  $('pat-category').innerHTML = r.sections.length
    ? `${esc(r.category)}<span class="slot" title="tournament slot by rules">${slotName}</span>` : '';
  const tags = $('pat-tags');
  tags.innerHTML = r.suggestedTags.length ? '' : '<div class="muted">No tags fit strongly.</div>';
  for (const t of r.suggestedTags) {
    const d = document.createElement('div');
    d.className = 'tag';
    d.innerHTML = `<code>${esc(t.tag)}</code><span class="score">${t.score !== undefined ? t.score.toFixed(2) : ''}</span><span class="why">${esc(t.reason)}</span>`;
    tags.append(d);
  }

  const bars = $('pat-bars');
  bars.innerHTML = '';
  for (const t of r.dominant) {
    const info = PATTERN_INFO[t];
    const pct = (r.byTime[t] ?? 0) * 100;
    const d = document.createElement('div');
    d.className = 'bar';
    d.title = `${info.description} — ${((r.byNotes[t] ?? 0) * 100).toFixed(1)}% of notes`;
    d.innerHTML = `<span><span class="swatch" style="background:${info.color}"></span>${info.name}</span>`
      + `<span class="track"><span class="fill" style="display:block;width:${pct}%;background:${info.color}"></span></span>`
      + `<span class="pct">${pct.toFixed(1)}%</span>`;
    bars.append(d);
  }

  $('pat-groups').innerHTML = Object.entries(r.byGroup)
    .sort((a, b) => b[1]! - a[1]!)
    .map(([g, v]) => `<span class="chip">${g} ${Math.round(v! * 100)}%</span>`).join('');

  renderPatternList();
}

function renderPatternList() {
  const r = editor.patterns;
  const list = $('pat-list');
  list.innerHTML = '';
  if (!r) return;
  const min = Number($<HTMLInputElement>('pat-min').value) || 1;
  const filter = $<HTMLSelectElement>('pat-filter').value;
  const shown = r.sections.filter((s) => s.rows >= min && (!filter || s.type === filter));
  for (const s of shown.slice(0, 400)) {
    const info = PATTERN_INFO[s.type];
    const d = document.createElement('div');
    d.className = 'item pat';
    d.style.borderLeftColor = info.color;
    const t = describeTags(s);
    const extra = t ? ` · ${t}` : '';
    d.innerHTML = `<span>${fmtTime(s.start)}</span><span class="grow">${esc(info.name)} <span class="muted">${esc(s.speed)} · ${s.notes} notes · ${s.nps.toFixed(1)} nps${extra}</span></span>`;
    d.title = info.description;
    d.addEventListener('click', () => {
      editor.seek(s.start);
      editor.selected = new Set(r.rows.slice(s.firstRow, s.lastRow + 1).flatMap((row) => row.notes));
      status(`Selected ${editor.selected.size} notes: ${info.name} ${fmtTime(s.start)}–${fmtTime(s.end)}`);
    });
    list.append(d);
  }
  if (!shown.length) list.innerHTML = '<div class="muted">No sections match.</div>';
}

$('pat-run').addEventListener('click', runPatterns);
$('pat-min').addEventListener('input', renderPatternList);
$('pat-filter').addEventListener('change', renderPatternList);
$<HTMLInputElement>('pat-lane').addEventListener('change', (e) => { editor.showPatterns = (e.target as HTMLInputElement).checked; });
$('pat-select').addEventListener('click', () => {
  const r = editor.patterns ?? classifyPatterns(editor.map);
  const t = $<HTMLSelectElement>('pat-type').value as PatternType;
  editor.selected = new Set(notesOfType(r, t));
  status(`Selected ${editor.selected.size} notes in ${PATTERN_INFO[t].name} sections`);
});

// ------------------------------------------------------------------ help panel

$<HTMLInputElement>('layout').addEventListener('change', (e) => {
  const v = (e.target as HTMLInputElement).value.toLowerCase();
  if (v.length !== editor.keys) { status(`Layout needs exactly ${editor.keys} characters`); return; }
  editor.layout = v;
  status(`Live-mapping keys: ${v}`);
});
$('layout-reset').addEventListener('click', () => { editor.layout = defaultLayout(editor.keys); refreshUI(); });

// ------------------------------------------------------------------ refresh

function refreshUI() {
  $$('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === editor.mode));
  $('live').classList.toggle('on', editor.live);
  $<HTMLSelectElement>('divisor').value = String(editor.divisor);
  $<HTMLInputElement>('layout').value = editor.layout;
  const k = getKeys(editor.map);
  $<HTMLInputElement>('am-keys').placeholder = String(k);
  if (!document.activeElement || document.activeElement.id !== 'am-keys') $<HTMLInputElement>('am-keys').value = String(k);
  if (document.activeElement?.closest('#meta-form, #diff-form') == null) renderSongForms();
  renderTiming();
  renderRange();
  if (!$('issues').closest('section')!.hidden) renderCheck();
}

refreshUI();
runPatterns();

// ------------------------------------------------------------------ views: Generate (studio) and Editor

const VIEW_KEY = 'maniamap.view';
type View = 'studio' | 'editor';
function setView(v: View) {
  $('view-studio').hidden = v !== 'studio';
  $('view-editor').hidden = v !== 'editor';
  editor.active = v === 'editor';
  $$('#appbar .viewtabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ }
}
$$('#appbar .viewtabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view as View)));

initStudio({
  audio,
  isVisible: () => !$('view-studio').hidden,
  openInEditor: (osu) => {
    const map = parseOsu(osu);
    oszFiles = {};
    currentOsuName = '';
    $<HTMLSelectElement>('diff-select').hidden = true;
    editor.load(map);
    editor.layout = defaultLayout(getKeys(map));
    setView('editor');
    refreshUI();
    status(`Opened the generated ${getKeys(map)}K chart (${map.notes.length} notes). Edit it by hand, then Export .osz.`);
  },
});

let startView: View = 'studio';
try { if (localStorage.getItem(VIEW_KEY) === 'editor' && restored) startView = 'editor'; } catch { /* storage unavailable */ }
setView(location.hash === '#editor' ? 'editor' : location.hash === '#generate' ? 'studio' : startView);
