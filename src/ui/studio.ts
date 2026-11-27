/**
 * The Generate screen: song -> keys / target stars / style -> chart, with a live preview,
 * a report (difficulty graph, pattern mix, clean check) and mapset export.
 * Heavy work (analysis, generation, reports) runs in a worker.
 */
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { parseOsu, createBeatmap, writeOsu, osuFileName, sortNotes, makeNote, type Note, type TimingPoint } from '../core/beatmap';
import { STYLES, placeColumns, type Style, type PlannedRow } from '../automap/patternize';
import type { StyleChoice } from '../automap/generate';
import { STEREO_WIDTH_AUTO } from '../automap/analysis';
import { referenceMappers, mapperName } from '../ai/mappers';
import { defaultLora, aiDefaultsFor } from '../ai/defaults';
import { rng } from '../core/rng';
import { rebirthToOfficial } from '../tools/difficultyfit';
import { lnConvert } from '../tools/lnconvert';
import type { AudioPlayer } from './audio';
import { drawPlayfield } from './playfield';
import { starColor, starTextColor, starGradient, tierName } from './stars';
import type { Report, GenRequest, WorkerIn } from './worker';

export interface StudioDeps {
  audio: AudioPlayer;
  /** open a generated chart in the editor (switches view) */
  openInEditor: (osu: string) => void;
  /** whether the Generate view is visible */
  isVisible: () => boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const API_HEADERS = { 'x-maniamap': '1', 'content-type': 'application/json' };
const SKILL_COLORS: Record<string, string> = {
  Stream: '#4fc0ff', Jumpstream: '#7c8cff', Handstream: '#b46cff', Chordstream: '#ff6cd2', Jackspeed: '#ff9a5c',
  Chordjack: '#ff5c6c', Technical: '#4fffd5', LN: '#ffd25a', Slow: '#6b7489',
};
const KEY_CHIPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18];

interface Result { report: Report; req: GenRequest; reached: boolean; notes: Note[]; engine: string; ai: boolean }

type Engine = 'builtin' | 'ai' | 'mug';

export function initStudio(deps: StudioDeps) {
  const { audio } = deps;
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let nextId = 1;
  const pending = new Map<number, (v: any) => void>();
  worker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p(e.data); } };
  const call = <R = any>(msg: Omit<WorkerIn, 'id'> & Record<string, unknown>, transfer: Transferable[] = []): Promise<R> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (d) => (d.ok ? resolve(d) : reject(new Error(d.error))));
      worker.postMessage({ ...msg, id }, transfer);
    });

  const state = {
    keys: 4, stars: 3.5, style: 'auto' as StyleChoice, engine: 'builtin' as Engine,
    tempo: null as { bpm: number; offset: number } | null,
    songName: '', analysed: false,
    result: null as Result | null,
    mapset: [] as Result[],
    seed: 7,
    /** red lines from a dropped .osz; used instead of the detected BPM */
    timing: null as TimingPoint[] | null,
    /** state.timing came from tempo-change detection, not from an .osz */
    timingDetected: false,
    /** how panned the song's onsets are (0 = mono); decides 'auto' sound direction */
    stereoWidth: 0,
  };
  const renderDirectionHint = () => {
    const w = state.stereoWidth, sel = $<HTMLSelectElement>('st-direction').value;
    $('st-direction-hint').textContent = !w ? 'This song is mono: notes follow pitch.'
      : sel === 'auto' ? (w >= STEREO_WIDTH_AUTO ? `Panned mix (width ${w.toFixed(2)}): notes follow the stereo position.` : `Mostly centred mix (width ${w.toFixed(2)}): notes follow pitch. Pick "Stereo position" to follow the panning anyway.`)
      : '';
  };

  // ------------------------------------------------------------ toast + busy
  let toastTimer = 0;
  const toast = (msg: string, kind: 'info' | 'warn' = 'info') => {
    const t = $('st-toast');
    t.textContent = msg;
    t.className = `toast ${kind}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { t.hidden = true; }, 4200);
  };
  const busy = (on: boolean, text = 'Generating…', sub = '') => {
    $('st-busy').hidden = !on;
    const cta = $<HTMLButtonElement>('st-generate');
    cta.classList.toggle('working', on);
    cta.querySelector('span')!.textContent = on ? text : 'Generate';
    if (on) cta.disabled = true; else cta.disabled = !state.analysed;
    $('st-busy-text').textContent = text;
    $('st-busy-sub').textContent = sub;
  };

  // ------------------------------------------------------------ keys
  const keyBox = $('st-keys');
  for (const k of KEY_CHIPS) {
    const b = document.createElement('button');
    b.className = 'keychip';
    b.textContent = `${k}K`;
    b.dataset.k = String(k);
    b.addEventListener('click', () => { state.keys = k; renderKeys(); renderStyles(); });
    keyBox.append(b);
  }
  const renderKeys = () => {
    keyBox.querySelectorAll<HTMLElement>('.keychip').forEach((b) => b.classList.toggle('on', Number(b.dataset.k) === state.keys));
    $('st-keys-hint').textContent = `${state.keys} columns`;
  };

  // ------------------------------------------------------------ stars
  const slider = $<HTMLInputElement>('st-stars');
  slider.style.setProperty('--track', starGradient(0.5, 12.5));
  const tiers = $('st-tiers');
  for (const [name, s] of [['Easy', 1.5], ['Normal', 2.3], ['Hard', 3.3], ['Insane', 4.6], ['Expert', 5.9], ['Expert+', 7.2]] as const) {
    const b = document.createElement('button');
    b.textContent = name;
    b.style.setProperty('--c', starColor(s));
    b.addEventListener('click', () => { slider.value = String(s); renderStars(); });
    tiers.append(b);
  }
  const badge = (el: HTMLElement, s: number) => {
    el.textContent = `★ ${s.toFixed(2)}`;
    el.style.background = starColor(s);
    el.style.color = starTextColor(s);
  };
  const renderStars = () => {
    state.stars = Number(slider.value);
    badge($('st-star-badge'), state.stars);
    slider.style.setProperty('--thumb', starColor(state.stars));
    $('st-stars-hint').textContent = `${tierName(state.stars)} · Star Rating Rebirth · ≈ ${rebirthToOfficial(state.stars).toFixed(1)}★ in osu! today`;
    tiers.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.textContent === tierName(state.stars)));
  };
  slider.addEventListener('input', renderStars);

  // ------------------------------------------------------------ styles (cards with a live mini pattern)
  const styleBox = $('st-styles');
  const styleCanvases = new Map<StyleChoice, { canvas: HTMLCanvasElement; notes: Note[]; keys: number }>();
  const styleLabel = (k: StyleChoice) => (k === 'auto' ? 'Auto' : STYLES[k].label);
  for (const key of ['auto', ...Object.keys(STYLES)] as StyleChoice[]) {
    const def = key === 'auto'
      ? { label: 'Auto', description: 'Learned from ranked maps: picks a style per section' }
      : STYLES[key];
    const b = document.createElement('button');
    b.className = 'stylecard';
    b.dataset.style = key;
    const c = document.createElement('canvas');
    const label = document.createElement('div');
    label.className = 'sc-label';
    label.innerHTML = `<b></b><span></span>`;
    label.querySelector('b')!.textContent = def.label;
    label.querySelector('span')!.textContent = def.description;
    b.append(c, label);
    b.addEventListener('click', () => { state.style = key; renderStyles(); });
    styleBox.append(b);
    styleCanvases.set(key, { canvas: c, notes: [], keys: 0 });
  }
  const sampleNotes = (choice: StyleChoice, K: number): Note[] => {
    if (choice === 'auto') {
      // a medley: stream -> jumpstream -> chordjack -> balanced, as the auto style would switch
      const parts = (['stream', 'jumpstream', 'chordjack', 'balanced'] as Style[]).map((st, i) =>
        sampleNotes(st, K).filter((n) => n.time >= 1000 + i * 1600 && n.time < 1000 + (i + 1) * 1600));
      return sortNotes(parts.flat());
    }
    const style = choice;
    const beat = 400;
    const def = STYLES[style];
    const sizes: number[] = [];
    for (let i = 0; i < 64; i++) {
      const on = i % 4 === 0, half = i % 2 === 0;
      let s = 1;
      if (style === 'chordjack') s = on ? 3 : half ? 2 : (i % 4 === 3 ? 0 : 2);
      else if (style === 'jumpstream') s = on ? 2 : half && i % 8 === 6 ? 2 : 1;
      else if (style === 'tech') s = i % 8 < 4 ? (half ? 2 : 1) : 1;
      else if (style === 'stream') s = 1;
      else if (style === 'ln') s = half ? 1 : 0;
      else s = on ? 2 : (i % 16 > 11 ? 0 : 1);
      sizes.push(Math.max(0, Math.min(K, s)));
    }
    const rows: PlannedRow[] = [];
    sizes.forEach((s, i) => { if (s) rows.push({ t: 1000 + i * beat / 4, size: s, centroid: 0.5 + 0.35 * Math.sin(i / 5), beatFrac: (i % 4) / 4, beatIndex: Math.floor(i / 4) }); });
    const cols = placeColumns(rows, { keys: K, beatLen: beat, style: def, pitchFollow: 0.3, rand: rng(K * 31 + style.length) });
    const m = createBeatmap({ keys: K, bpm: 150, offset: 1000 });
    m.notes = sortNotes(rows.flatMap((r, i) => cols[i].map((c) => makeNote(r.t, c))));
    if (def.ln) m.notes = lnConvert(m, { preset: 'full', seed: 3 }).notes;
    return m.notes;
  };
  const renderStyles = () => {
    styleBox.querySelectorAll<HTMLElement>('.stylecard').forEach((b) => b.classList.toggle('on', b.dataset.style === state.style));
    const K = Math.min(state.keys, 10);
    for (const [key, v] of styleCanvases) if (v.keys !== K) { v.notes = sampleNotes(key, K); v.keys = K; }
  };

  // ------------------------------------------------------------ advanced
  for (const id of ['st-ln', 'st-pitch']) {
    const i = $<HTMLInputElement>(id);
    const o = i.nextElementSibling as HTMLOutputElement;
    i.addEventListener('input', () => { o.value = Number(i.value).toFixed(2); });
  }
  // ------------------------------------------------------------ engine: the AI model when installed
  let aiReady = false;
  let mugReady = false;
  let preferredEngine: Engine | null = null;
  let installedLoras: string[] = [];
  let aiProblem = 'checking…';
  /** started by "maniamap editor" (the local server answers): setup and AI jobs are possible */
  let serverOk = true;
  const setEngine = (e: Engine) => {
    state.engine = e;
    if (e === 'mug' && state.keys !== 4) { state.keys = 4; renderKeys(); renderStyles(); toast('MuG Diffusion maps 4K only: switched to 4K.'); }
    document.querySelectorAll<HTMLElement>('#st-engine button').forEach((x) => x.classList.toggle('on', x.dataset.engine === e));
    document.querySelectorAll<HTMLElement>('.ai-only').forEach((x) => { x.hidden = e !== 'ai'; });
    const hint = $('st-engine-hint');
    hint.classList.toggle('warn', e === 'builtin');
    hint.textContent = e === 'ai'
      ? 'Mapperatorinator V32, the osu!mania model trained on ranked maps (OliBomby, MIT). On a CPU a 1-minute song takes a few minutes. Disclose AI use when you share a map.'
      : e === 'mug'
      ? 'MuG Diffusion (Keytoyze): a diffusion model for osu!mania 4K, steered by stars, style (stream / jumpstream / chordjack / tech) and LN amount. Its weights and the charts it makes are non-commercial; charts keep its AIMode tag.'
      : aiReady
        ? 'Quick rules: instant drafts from onset detection and pattern rules. Much lower quality than the AI model.'
        : 'Quick rules only: the AI mapper is not set up yet, so maps are drafts. Set it up below for real-quality charts.';
    $('st-engine-state').textContent = aiReady ? 'AI model installed' : 'AI model not installed';
    $('st-setup').hidden = aiReady || !serverOk;
    renderMappers();
    updateCta();
  };
  document.querySelectorAll<HTMLElement>('#st-engine button').forEach((b) => b.addEventListener('click', () => {
    const e = b.dataset.engine as Engine;
    if (e === 'ai' && !aiReady) { toast(`The AI model is not available: ${aiProblem}`, 'warn'); return; }
    setEngine(e);
  }));
  // MuG Diffusion is 4K only: picking other keys while it is selected goes back to the AI / rules
  keyBox.addEventListener('click', () => { if (state.engine === 'mug' && state.keys !== 4) setEngine(aiReady ? 'ai' : 'builtin'); });
  const mapperSel = $<HTMLSelectElement>('st-mapper');
  const renderMappers = () => {
    const keep = mapperSel.value;
    const list = referenceMappers(state.keys, rebirthToOfficial(state.stars), [], 12);
    mapperSel.innerHTML = `<option value="auto">Auto: ${list[0] ? `${list[0].name} (best ranked fit for ${state.keys}K ★${state.stars.toFixed(1)})` : 'no known mapper for these keys/stars'}</option><option value="">None</option>`
      + list.map((m) => `<option value="${m.id}">${m.name} · ${Object.entries(m.byKeys).map(([k, v]) => `${k}K ${v.min.toFixed(1)}–${v.max.toFixed(1)}★`).join(', ')}</option>`).join('');
    mapperSel.value = [...mapperSel.options].some((o) => o.value === keep) ? keep : 'auto';
  };
  const chosenMapper = (): number | undefined => {
    if (mapperSel.value === '') return undefined;
    if (mapperSel.value === 'auto') return referenceMappers(state.keys, rebirthToOfficial(state.stars))[0]?.id;
    return Number(mapperSel.value);
  };
  slider.addEventListener('input', () => renderMappers());
  // per-key defaults (model + reference mapper) until the player picks something by hand
  let touchedModel = false, touchedMapper = false;
  $('st-model').addEventListener('change', () => { touchedModel = true; });
  mapperSel.addEventListener('change', () => { touchedMapper = true; });
  $('st-direction').addEventListener('change', () => renderDirectionHint());
  const applyKeyDefaults = () => {
    const d = aiDefaultsFor(state.keys);
    if (!touchedModel) $<HTMLSelectElement>('st-model').value = d.model;
    renderMappers();
    if (!touchedMapper) mapperSel.value = d.mapper === 'auto' ? 'auto' : '';
  };
  keyBox.addEventListener('click', applyKeyDefaults);
  void (async () => {
    try {
      const s = await (await fetch('api/ai/status', { headers: API_HEADERS })).json();
      aiReady = !!s.available;
      aiProblem = s.problem ?? '';
      mugReady = !!s.mug?.available;
      installedLoras = (s.loras ?? []).map((l: { name: string }) => l.name);
      (document.querySelector('#st-engine button[data-engine="mug"]') as HTMLElement).hidden = !mugReady;
      if (s.version) $('app-version').textContent = `maniamap ${s.version} · osu!mania 1K–18K · runs on your computer`;
      $('app-quit').hidden = false;
    } catch {
      aiReady = false;
      serverOk = false;
      aiProblem = 'the app was not started with "maniamap editor"';
    }
    if (!aiReady && serverOk) void renderSetupBlockers();
    applyKeyDefaults();
    setEngine(preferredEngine === 'mug' && mugReady && state.keys === 4 ? 'mug'
      : preferredEngine === 'builtin' ? 'builtin' : aiReady ? 'ai' : 'builtin');
  })();

  // ------------------------------------------------------------ quit (stops the local server)
  $('app-quit').addEventListener('click', async () => {
    const busyNow = !$('st-busy').hidden || !$('st-setup-progress').hidden && !$('st-setup-spin').hidden;
    if (busyNow && !confirm('maniamap is still working. Quit anyway? The current job stops.')) return;
    try { await fetch('api/quit', { method: 'POST', headers: API_HEADERS }); } catch { /* already gone */ }
    // an overlay (the page's own render loops keep their elements)
    const cover = document.createElement('div');
    cover.style.cssText = 'position:fixed;inset:0;z-index:99999;display:grid;place-items:center;font:15px system-ui;color:#ccc;background:#0e0e14;text-align:center;padding:16px';
    cover.innerHTML = '<div><div style="font-size:20px;color:#fff;margin-bottom:8px">maniamap has stopped.</div>You can close this tab. Start it again from your applications menu or with <code>maniamap editor</code>.</div>';
    document.body.appendChild(cover);
  });

  // ------------------------------------------------------------ AI setup from the app
  interface DoctorCheck { id: string; label: string; state: string; detail: string; fix?: string }
  async function renderSetupBlockers() {
    try {
      const d = await (await fetch('api/doctor', { headers: API_HEADERS })).json() as { checks: DoctorCheck[]; setup?: { id: string; state: string } | null };
      // the setup needs git, and the AI reads audio with ffmpeg: these need the system's package manager
      const blockers = d.checks.filter((c) => (c.id === 'git' || c.id === 'ffmpeg' || c.id === 'disk') && c.state !== 'ok');
      $('st-setup-blockers').innerHTML = blockers.map((c) => `<li>${c.label}: ${c.detail}${c.fix ? ` — in a terminal: <code>${c.fix}</code>` : ''}</li>`).join('');
      $<HTMLButtonElement>('st-setup-go').disabled = blockers.some((c) => c.id !== 'disk' && c.state === 'missing');
      if (d.setup?.state === 'running') followSetup(d.setup.id);
    } catch { /* not served by maniamap editor */ }
  }
  let setupTimer = 0, lastLogLength = -1, lastLogAt = Date.now();
  const followSetup = (id: string) => {
    $('st-setup-progress').hidden = false;
    $('st-setup-cancel').hidden = false;
    $<HTMLButtonElement>('st-setup-go').disabled = true;
    clearInterval(setupTimer);
    const tick = async () => {
      try {
        const j = await (await fetch(`api/setup/${id}`, { headers: API_HEADERS })).json() as { state: string; seconds: number; log: string[] };
        const pre = $('st-setup-log');
        pre.textContent = j.log.slice(-14).join('\n');
        pre.scrollTop = pre.scrollHeight;
        const last = [...j.log].reverse().find((l) => l.startsWith('==>'))?.replace(/^==>\s*/, '') ?? 'working';
        const mins = `${Math.floor(j.seconds / 60)}:${String(j.seconds % 60).padStart(2, '0')}`;
        // big downloads (PyTorch, the model) print nothing for a while: say it is still going
        if (j.log.length !== lastLogLength) { lastLogLength = j.log.length; lastLogAt = Date.now(); }
        const quiet = Date.now() - lastLogAt > 20000 ? ' · still working: large downloads show no progress here, this is normal' : '';
        $('st-setup-state').textContent = j.state === 'running' ? `${last} (${mins})${quiet}`
          : j.state === 'done' ? 'Done.'
          : j.state === 'cancelled' ? 'Cancelled. Set up the AI again to continue where it stopped (finished downloads are kept).'
          : 'The setup stopped. The log above says why; "maniamap doctor" in a terminal lists what is missing. Running it again continues where it stopped.';
        $('st-setup-spin').hidden = j.state !== 'running';
        if (j.state === 'running') return;
        clearInterval(setupTimer);
        $('st-setup-cancel').hidden = true;
        $<HTMLButtonElement>('st-setup-go').disabled = false;
        if (j.state === 'done') {
          const s = await (await fetch('api/ai/status', { headers: API_HEADERS })).json();
          aiReady = !!s.available;
          aiProblem = s.problem ?? '';
          installedLoras = (s.loras ?? []).map((l: { name: string }) => l.name);
          if (aiReady) { setEngine('ai'); toast('The AI mapper is ready. Generate again for a real-quality chart.'); }
        }
      } catch { /* keep polling */ }
    };
    void tick();
    setupTimer = window.setInterval(tick, 1500);
  };
  $('st-setup-go').addEventListener('click', async () => {
    const r = await fetch('api/setup', { method: 'POST', headers: { ...API_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify({ what: 'ai', cpu: $<HTMLInputElement>('st-setup-cpu').checked }) });
    const j = await r.json();
    if (j.id) followSetup(j.id); else toast(j.error ?? 'could not start the setup', 'warn');
  });
  $('st-setup-cancel').addEventListener('click', async () => {
    if (!confirm('Stop the AI setup? You can start it again later; it continues where it stopped.')) return;
    const id = (await (await fetch('api/doctor', { headers: API_HEADERS })).json()).setup?.id;
    if (id) await fetch(`api/setup/${id}/cancel`, { method: 'POST', headers: API_HEADERS });
  });

  // ------------------------------------------------------------ song loading
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    let bytes = new Uint8Array(await f.arrayBuffer());
    let name = f.name;
    let title = '', artist = '';
    let timing: TimingPoint[] | null = null;
    if (name.toLowerCase().endsWith('.osz')) {
      const files = unzipSync(bytes);
      const osu = Object.keys(files).find((n) => n.toLowerCase().endsWith('.osu'));
      const text = osu ? strFromU8(files[osu]) : '';
      const audioName = /AudioFilename\s*:\s*(.+)/.exec(text)?.[1]?.trim() ?? '';
      const key = Object.keys(files).find((n) => n.toLowerCase() === audioName.toLowerCase())
        ?? Object.keys(files).find((n) => /\.(mp3|ogg|wav|opus|flac)$/i.test(n));
      if (!key) { toast('No audio found in this .osz', 'warn'); return; }
      bytes = files[key];
      name = key;
      try {
        const reds = parseOsu(text).timingPoints.filter((p) => p.uninherited && p.beatLength > 0);
        if (reds.length) timing = reds;
      } catch { /* not a parsable map: detect the tempo instead */ }
      title = /^Title\s*:(.*)$/m.exec(text)?.[1]?.trim() ?? '';
      artist = /^Artist\s*:(.*)$/m.exec(text)?.[1]?.trim() ?? '';
    }
    if (!title) {
      const base = f.name.replace(/\.[^.]+$/, '');
      const m = /^(.+?)\s+-\s+(.+)$/.exec(base);
      artist = m ? m[1] : '';
      title = m ? m[2] : base;
    }
    $<HTMLInputElement>('st-title').value = title;
    $<HTMLInputElement>('st-artist').value = artist;
    $('st-drop').hidden = true;
    $('st-song').hidden = false;
    $('st-analysing').hidden = false;
    state.analysed = false;
    state.songName = name;
    updateCta();
    busy(false);
    try {
      await audio.load(bytes, name);
      if (!audio.samples) throw new Error('your browser could not decode this audio file');
      $('st-dur').textContent = fmt(audio.durationMs);
      const r = await call<{ bpm: number; offset: number; confidence: number; stereoWidth: number; timing: TimingPoint[] | null }>({
        type: 'analyze', samples: audio.samples.slice(), rate: 22050,
        ...(audio.stereo ? { left: audio.stereo[0].slice(), right: audio.stereo[1].slice() } : {}),
      });
      state.stereoWidth = r.stereoWidth ?? 0;
      renderDirectionHint();
      // an .osz brings its own timing; otherwise detected tempo changes, if any
      const detected = !timing && r.timing && r.timing.length > 1 ? r.timing : null;
      state.timing = timing ?? detected;
      state.timingDetected = !!detected;
      const t0 = state.timing;
      const bpm = t0 ? Math.round((60000 / t0[0].beatLength) * 100) / 100 : r.bpm;
      const offset = t0 ? t0[0].time : r.offset;
      state.tempo = { bpm, offset };
      $<HTMLInputElement>('st-bpm').value = String(bpm);
      $<HTMLInputElement>('st-offset').value = String(Math.round(offset));
      renderTimingNote();
      state.analysed = true;
      toast(timing ? `Using the timing from the .osz (${timing.length} red line${timing.length === 1 ? '' : 's'}).`
        : detected ? `Detected ${detected.length} tempo sections, starting at ${bpm} BPM.` : `Detected ${r.bpm} BPM. Use ×2 / ÷2 if it feels half or double.`);
    } catch (e) {
      toast(`Could not read the song: ${(e as Error).message}`, 'warn');
    }
    $('st-analysing').hidden = true;
    updateCta();
  };
  $<HTMLInputElement>('st-file').addEventListener('change', (e) => void onFile((e.target as HTMLInputElement).files?.[0]));
  $<HTMLInputElement>('st-file2').addEventListener('change', (e) => void onFile((e.target as HTMLInputElement).files?.[0]));
  const drop = $('st-drop');
  for (const el of [document.body]) {
    el.addEventListener('dragover', (e) => { if (!deps.isVisible()) return; e.preventDefault(); drop.classList.add('over'); document.body.classList.add('dragging'); });
    el.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) { drop.classList.remove('over'); document.body.classList.remove('dragging'); } });
    el.addEventListener('drop', (e) => {
      if (!deps.isVisible()) return;
      e.preventDefault();
      drop.classList.remove('over');
      document.body.classList.remove('dragging');
      void onFile(e.dataTransfer?.files?.[0]);
    });
  }
  const renderTimingNote = () => {
    const el = $('st-timing-note');
    el.hidden = !state.timing || state.timing.length < 2;
    if (state.timing) el.textContent = state.timingDetected
      ? `${state.timing.length} tempo sections detected (${state.timing.map((p) => Math.round(60000 / p.beatLength)).join(' → ')} BPM). Editing the BPM uses one constant tempo.`
      : `${state.timing.length} red lines from the .osz (tempo changes kept)`;
  };
  const tempoInput = () => {
    const bpm = Number($<HTMLInputElement>('st-bpm').value), off = Number($<HTMLInputElement>('st-offset').value);
    if (bpm > 20 && bpm < 1000) state.tempo = { bpm, offset: off || 0 };
    state.timing = null; // edited by hand: one constant BPM
    renderTimingNote();
  };
  $('st-bpm').addEventListener('change', tempoInput);
  $('st-offset').addEventListener('change', tempoInput);
  const scaleBpm = (f: number) => {
    if (!state.tempo) return;
    const bpm = Math.round(state.tempo.bpm * f * 100) / 100;
    if (bpm < 30 || bpm > 600) return;
    $<HTMLInputElement>('st-bpm').value = String(bpm);
    tempoInput();
  };
  $('st-bpm-x2').addEventListener('click', () => scaleBpm(2));
  $('st-bpm-half').addEventListener('click', () => scaleBpm(0.5));

  const updateCta = () => {
    const ok = state.analysed;
    $<HTMLButtonElement>('st-generate').disabled = !ok;
    $('st-cta-hint').textContent = !state.songName ? 'Drop a song to start' : !ok ? 'Analysing the song…' : `${state.keys}K · ★ ${state.stars.toFixed(2)} · ${styleLabel(state.style)}`;
  };
  for (const id of ['st-stars']) $(id).addEventListener('input', updateCta);
  keyBox.addEventListener('click', updateCta);
  styleBox.addEventListener('click', updateCta);

  // ------------------------------------------------------------ playback
  const togglePlay = () => { if (audio.loaded) void audio.toggle(); };
  $('st-play').addEventListener('click', togglePlay);
  $('r-play').addEventListener('click', togglePlay);
  window.addEventListener('keydown', (e) => {
    if (!deps.isVisible()) return;
    const tag = (e.target as HTMLElement).tagName;
    if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); togglePlay(); }
  });
  const seekFromCanvas = (c: HTMLCanvasElement, e: MouseEvent, startMs = 0, endMs = audio.durationMs) => {
    const r = c.getBoundingClientRect();
    audio.seek(startMs + ((e.clientX - r.left) / r.width) * (endMs - startMs));
  };
  $<HTMLCanvasElement>('st-wave').addEventListener('click', (e) => seekFromCanvas($<HTMLCanvasElement>('st-wave'), e));
  $<HTMLCanvasElement>('r-graph').addEventListener('click', (e) => seekFromCanvas($<HTMLCanvasElement>('r-graph'), e));

  // ------------------------------------------------------------ generate
  const versionName = (stars: number) => `${tierName(stars)} ${state.keys}K${state.style !== 'balanced' && state.style !== 'auto' ? ` ${STYLES[state.style].label}` : ''}`;
  const request = (stars = state.stars, seed = state.seed): GenRequest => {
    const title = $<HTMLInputElement>('st-title').value.trim() || 'Untitled';
    const artist = $<HTMLInputElement>('st-artist').value.trim() || 'Unknown';
    return {
      keys: state.keys, stars, style: state.style, bpm: state.tempo!.bpm, offset: state.tempo!.offset, seed, timing: state.timing ?? undefined,
      lnRatio: Number($<HTMLInputElement>('st-ln').value), pitchFollow: Number($<HTMLInputElement>('st-pitch').value),
      direction: $<HTMLSelectElement>('st-direction').value as GenRequest['direction'],
      metadata: { title, artist, creator: $<HTMLInputElement>('st-creator').value.trim() || 'maniamap', version: versionName(stars), audioFilename: state.songName },
    };
  };

  const generate = async (req: GenRequest): Promise<Result> => {
    if (state.engine === 'ai' || state.engine === 'mug') return generateAi(req);
    const r = await call<{ report: Report; reached: boolean }>({ type: 'generate', req });
    return { report: r.report, req, reached: r.reached, notes: parseOsu(r.report.osu).notes, engine: 'Quick rules (not the AI model)', ai: false };
  };

  const generateAi = async (req: GenRequest): Promise<Result> => {
    const mug = state.engine === 'mug';
    const mapperId = mug ? undefined : chosenMapper();
    const t0 = performance.now();
    const tmap = createBeatmap({ keys: req.keys, bpm: req.bpm, offset: req.offset, audioFilename: state.songName });
    if (req.timing?.length) tmap.timingPoints = req.timing.map((p) => ({ ...p }));
    const timing = writeOsu(tmap);
    const tags = { stream: ['skillset/streams'], jumpstream: ['style/jumpstream'], chordjack: ['style/chordjack'], tech: ['skillset/tech'], ln: ['style/LN mixed'], balanced: [] as string[], auto: [] as string[] }[req.style];
    const r = await fetch('api/ai/jobs', {
      method: 'POST', headers: API_HEADERS,
      body: JSON.stringify({
        audioBase64: toBase64(audio.bytes!), audioName: state.songName, keys: req.keys, stars: req.stars, fit: true,
        // hold-note ratio the model is asked for: rice maps are mostly 0-10% LN
        ln: req.style === 'ln' ? 0.5 : 0.05, sv: 0, tags, cfg: tags.length ? 1.5 : 1, seed: req.seed, mapperId,
        model: $<HTMLSelectElement>('st-model').value,
        // the best setup for these keys (per-key defaults), e.g. a 7K LoRA when it is installed
        lora: mug ? undefined : 'default',
        ...(mug ? { engine: 'mug', style: req.style, bpm: req.bpm, offset: req.offset, steps: 50 } : {}),
        device: 'auto', timingOsu: timing, title: req.metadata.title, artist: req.metadata.artist,
      }),
    }).catch(() => null);
    if (!r) throw new Error('the AI engine needs the local server: start the app with "maniamap editor"');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    for (;;) {
      await new Promise((res) => setTimeout(res, 1500));
      const s = await (await fetch(`api/ai/jobs/${j.id}`, { headers: API_HEADERS })).json();
      if (s.state === 'running') { busy(true, mug ? 'MuG Diffusion is charting…' : 'AI is mapping…', `${s.seconds}s · ${(s.log ?? []).slice(-1)[0] ?? ''}`.slice(0, 120)); continue; }
      if (s.state !== 'done') throw new Error(`AI ${s.state}: ${(s.error ?? '').split('\n')[0]}`);
      const m = parseOsu(s.osu);
      m.metadata.set('Version', req.metadata.version ?? 'AI');
      m.metadata.set('Creator', req.metadata.creator ?? 'maniamap');
      const rep = await call<{ report: Report }>({ type: 'report', osu: writeOsu(m) });
      const secs = Math.round((performance.now() - t0) / 1000);
      const lora = mug ? undefined : defaultLora(req.keys, installedLoras);
      const engine = mug ? `AI · MuG Diffusion v1 (4K, non-commercial) · ${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s` : `AI · Mapperatorinator ${$<HTMLSelectElement>('st-model').value === 'v32-mini' ? 'V32-mini' : 'V32'} mania model${lora ? ` + LoRA ${lora}` : ''}${mapperId ? ` · style of ${mapperName(mapperId)}` : ''} · ${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;
      return { report: rep.report, req, reached: Math.abs(rep.report.stars - req.stars) <= 0.15, notes: m.notes, engine, ai: true };
    }
  };

  const run = async (seed = state.seed) => {
    if (!state.analysed || !state.tempo) return;
    busy(true, state.engine === 'builtin' ? 'Generating…' : 'Starting the AI…', `${state.keys}K · ★ ${state.stars.toFixed(2)} · ${styleLabel(state.style)}`);
    const t0 = performance.now();
    try {
      const res = await generate(request(state.stars, seed));
      state.result = res;
      showResult(res);
      if (window.innerWidth < 900) $('st-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
      const miss = !res.reached && res.report.stars < state.stars - 0.15
        ? ` This song tops out around ★ ${res.report.stars.toFixed(1)} in ${state.keys}K without dirty jacks — try Chordjack, more keys, or a higher BPM.`
        : '';
      toast(`Generated in ${((performance.now() - t0) / 1000).toFixed(1)}s.${miss}`, miss ? 'warn' : 'info');
    } catch (e) {
      toast(`Generation failed: ${(e as Error).message}`, 'warn');
    }
    busy(false);
  };
  $('st-generate').addEventListener('click', () => void run());
  $('r-again').addEventListener('click', () => { state.seed = Math.floor(Math.random() * 1e6); $<HTMLInputElement>('st-seed').value = String(state.seed); void run(state.seed); });
  $('st-seed').addEventListener('change', () => { state.seed = Number($<HTMLInputElement>('st-seed').value) || 1; });

  // ------------------------------------------------------------ result
  const showResult = (res: Result) => {
    const rep = res.report;
    $('st-empty').hidden = true;
    $('st-result').hidden = false;
    badge($('r-star'), rep.stars);
    $('r-version').textContent = `${res.req.metadata.version}`;
    const eng = $('r-engine');
    eng.textContent = res.engine;
    eng.className = `r-engine ${res.ai ? 'ai' : 'rules'}`;
    $('r-sub').textContent = `${res.req.metadata.artist} — ${res.req.metadata.title} · ≈ ${rep.osuStars.toFixed(2)}★ in osu!`;
    const stat = (v: string, l: string) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
    $('r-stats').innerHTML = [
      stat(String(rep.notes), 'notes'), stat(rep.nps.toFixed(1), 'avg NPS'), stat(String(rep.peakNps), 'peak NPS'),
      stat(fmt(rep.lengthMs), 'length'), stat(`${Math.round((rep.lns / Math.max(1, rep.notes)) * 100)}%`, 'long notes'), stat(String(Math.round(res.req.bpm)), 'BPM'),
    ].join('');
    $('r-category').textContent = rep.category;
    const mix = Object.entries(rep.mix).filter(([, v]) => v > 0.01).sort((a, b) => b[1] - a[1]);
    const total = mix.reduce((s, [, v]) => s + v, 0) || 1;
    $('r-mix').innerHTML = `<div class="mix-bar">${mix.map(([k, v]) => `<span style="flex:${v};background:${SKILL_COLORS[k] ?? '#888'}" title="${k} ${Math.round((v / total) * 100)}%"></span>`).join('')}</div>`
      + `<div class="mix-legend">${mix.map(([k, v]) => `<span><i style="background:${SKILL_COLORS[k] ?? '#888'}"></i>${k}<b>${Math.round((v / total) * 100)}%</b></span>`).join('')}</div>`;
    const d = rep.dirt;
    const check = (ok: boolean, label: string, value: string) => `<div class="check ${ok ? 'ok' : 'warn'}"><svg><use href="#i-${ok ? 'check' : 'alert'}"/></svg><span>${label}</span><b>${value}</b></div>`;
    $('r-clean').innerHTML = [
      check(d.fastJacks < 1 || res.req.style === 'chordjack' || res.req.style === 'auto', 'Fast jacks',
        d.fastJacks < 1 ? 'none' : res.req.style === 'chordjack' || res.req.style === 'auto' ? 'chordjack (intended)' : `${d.fastJacks.toFixed(0)}/1k`),
      check(d.handImbalance < 0.15, 'Hand balance', d.handImbalance < 0.15 ? 'even' : `${Math.round(d.handImbalance * 100)}% off`),
      check(d.tightReleases < 1, 'LN releases', d.tightReleases < 1 ? 'clean' : `${d.tightReleases.toFixed(0)} tight`),
      check(Math.abs(rep.stars - res.req.stars) <= 0.15, 'Star target', `${rep.stars.toFixed(2)} / ${res.req.stars.toFixed(2)}`),
    ].join('');
    drawGraph();
    // pattern timeline under the graph (same time axis as the curve)
    const tl = $('r-timeline');
    tl.innerHTML = '';
    const t0 = rep.timeline[0]?.start ?? 0;
    const t1 = Math.max(t0 + 1, ...rep.timeline.map((x) => x.end));
    for (const sec of rep.timeline) {
      const seg = document.createElement('span');
      seg.style.left = `${((sec.start - t0) / (t1 - t0)) * 100}%`;
      seg.style.width = `${Math.max(0.3, ((sec.end - sec.start) / (t1 - t0)) * 100)}%`;
      seg.style.background = SKILL_COLORS[sec.group] ?? '#888';
      seg.title = `${sec.name} · ${fmt(sec.start)}–${fmt(sec.end)}`;
      tl.append(seg);
    }
  };

  const drawGraph = () => {
    const c = $<HTMLCanvasElement>('r-graph');
    const rep = state.result?.report;
    if (!rep) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const v = rep.curve;
    if (!v.length) return;
    const max = Math.max(...v, 1e-6);
    const path = new Path2D();
    path.moveTo(0, H);
    v.forEach((x, i) => path.lineTo((i / Math.max(1, v.length - 1)) * W, H - 4 - (x / max) * (H - 10)));
    path.lineTo(W, H);
    path.closePath();
    const g = ctx.createLinearGradient(0, 0, W, 0);
    for (let i = 0; i <= 10; i++) {
      const idx = Math.min(v.length - 1, Math.floor((i / 10) * v.length));
      g.addColorStop(i / 10, starColor((v[idx] / max) * rep.stars * 1.05));
    }
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = g;
    ctx.fill(path);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = g;
    ctx.lineWidth = 2;
    ctx.beginPath();
    v.forEach((x, i) => { const px = (i / Math.max(1, v.length - 1)) * W, py = H - 4 - (x / max) * (H - 10); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
    ctx.stroke();
  };
  window.addEventListener('resize', drawGraph);

  // ------------------------------------------------------------ export + editor
  const oszName = () => `${$<HTMLInputElement>('st-artist').value || 'Unknown'} - ${$<HTMLInputElement>('st-title').value || 'Untitled'}`.replace(/[\\/:*?"<>|]/g, '');
  const download = (name: string, data: Uint8Array) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const packOsz = (results: Result[]) => {
    const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
    for (const r of results) files[osuFileName(parseOsu(r.report.osu))] = strToU8(r.report.osu);
    if (audio.bytes) files[state.songName] = [audio.bytes, { level: 0 }];
    return zipSync(files, { level: 6 });
  };
  $('r-download').addEventListener('click', () => {
    if (!state.result) return;
    download(`${oszName()} [${state.result.req.metadata.version}].osz`, packOsz([state.result]));
    toast('Downloaded. Double-click the .osz (or drag it into osu!) to import it.');
  });
  $('r-editor').addEventListener('click', () => { if (state.result) deps.openInEditor(state.result.report.osu); });

  // ------------------------------------------------------------ mapset
  const renderMapset = () => {
    const box = $('ms-list');
    $<HTMLButtonElement>('ms-download').disabled = !state.mapset.length;
    if (!state.mapset.length) { box.innerHTML = '<div class="hint">Add difficulties here to export them together.</div>'; return; }
    box.innerHTML = '';
    state.mapset.sort((a, b) => a.report.stars - b.report.stars).forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'ms-item';
      row.innerHTML = `<span class="star-badge"></span><b></b><span class="hint"></span><button class="icon" title="Remove"><svg><use href="#i-x"/></svg></button>`;
      badge(row.querySelector('.star-badge') as HTMLElement, r.report.stars);
      row.querySelector('b')!.textContent = r.req.metadata.version ?? '';
      row.querySelector('.hint')!.textContent = `${r.report.notes} notes · ${r.report.keys}K`;
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) { state.mapset.splice(i, 1); renderMapset(); return; }
        state.result = r;
        showResult(r);
      });
      box.append(row);
    });
  };
  const uniqueVersions = () => {
    const seen = new Map<string, number>();
    for (const r of state.mapset) {
      const v = r.req.metadata.version ?? 'Diff';
      const n = (seen.get(v) ?? 0) + 1;
      seen.set(v, n);
      if (n > 1) {
        const m = parseOsu(r.report.osu);
        m.metadata.set('Version', `${v} ${n}`);
        r.req.metadata.version = `${v} ${n}`;
        r.report.osu = writeOsu(m);
      }
    }
  };
  $('ms-add').addEventListener('click', () => {
    if (!state.result || state.mapset.includes(state.result)) return;
    state.mapset.push(state.result);
    uniqueVersions();
    renderMapset();
  });
  $('ms-spread').addEventListener('click', async () => {
    if (!state.analysed || !state.tempo) return;
    if (state.engine === 'ai') toast('Generating every difficulty with the AI model: on a CPU this takes several minutes each.');
    const top = state.result?.req.stars ?? state.stars;
    const targets = [1.6, 2.4, 3.3, 4.4, 5.5, 6.6, 7.8, 9.0, 10.3, 11.6].filter((s) => s < top - 0.5).slice(-4).concat([top]);
    const engine = state.engine;
    try {
      for (const [i, s] of targets.entries()) {
        if (state.mapset.some((r) => Math.abs(r.req.stars - s) < 0.05 && r.req.keys === state.keys && r.req.style === state.style)) continue;
        busy(true, `Generating the spread (${i + 1}/${targets.length})`, `${tierName(s)} · ★ ${s.toFixed(2)}`);
        const res = await generate(request(s, state.seed + i));
        state.mapset.push(res);
        uniqueVersions();
        renderMapset();
      }
      toast(`Mapset has ${state.mapset.length} difficulties.`);
    } catch (e) {
      toast(`Spread failed: ${(e as Error).message}`, 'warn');
    }
    state.engine = engine;
    busy(false);
  });
  $('ms-download').addEventListener('click', () => {
    if (!state.mapset.length) return;
    download(`${oszName()}.osz`, packOsz(state.mapset));
    toast(`Downloaded ${state.mapset.length} difficulties in one .osz.`);
  });

  // ------------------------------------------------------------ animation loop
  const hero = $<HTMLCanvasElement>('st-hero');
  const heroNotes = (() => {
    const out: Note[] = [];
    const r = rng(42);
    const K = 7;
    let t = 0;
    let prev: number[] = [];
    for (let i = 0; i < 400; i++) {
      t += 150;
      const size = i % 8 === 0 ? 3 : i % 2 === 0 ? 2 : 1;
      const free = [...Array(K).keys()].filter((c) => !prev.includes(c)).sort(() => r() - 0.5).slice(0, size);
      for (const c of free) out.push(makeNote(t, c, i % 16 === 4 && c === free[0] ? t + 600 : undefined));
      prev = free;
    }
    return out;
  })();
  const t0 = performance.now();
  // drawing costs CPU the AI needs (and laptop battery): nothing while a chart is generated,
  // decorative previews at 20 fps, the waveform and result preview only while playing or after a change
  let lastPlaying: boolean | null = null, lastDeco = 0, lastIdle = 0;
  let lastPreview = { result: null as Result | null, now: -1, speed: '' };
  const frame = () => {
    requestAnimationFrame(frame);
    if (!deps.isVisible() || !$('st-busy').hidden) return;
    const tNow = performance.now();
    const playing = audio.playing;
    if (playing !== lastPlaying) {
      lastPlaying = playing;
      $('st-play').innerHTML = `<svg><use href="#i-${playing ? 'pause' : 'play'}"/></svg>`;
      $('r-play').innerHTML = `<svg><use href="#i-${playing ? 'pause' : 'play'}"/></svg>`;
    }
    if (tNow - lastDeco >= 50) {
      lastDeco = tNow;
      if (!$('st-empty').hidden) drawPlayfield(hero, { notes: heroNotes, keys: 7, time: ((tNow - t0) * 0.8) % 58000 + 1500, speed: 0.55, laneWidth: 46, receptors: true });
      for (const [, v] of styleCanvases) {
        const span = 64 * 100;
        drawPlayfield(v.canvas, { notes: v.notes, keys: v.keys, time: 1000 + ((tNow - t0) * 0.5) % span, speed: 0.12, laneWidth: 11, receptors: false });
      }
    }
    const idleTick = tNow - lastIdle >= 250;
    if (idleTick) lastIdle = tNow;
    if (!$('st-song').hidden && (playing || idleTick)) drawWave();
    if (state.result && !$('st-result').hidden) {
      const now = audio.now(), speed = $<HTMLInputElement>('r-speed').value;
      if (playing || now !== lastPreview.now || speed !== lastPreview.speed || state.result !== lastPreview.result) {
        lastPreview = { result: state.result, now, speed };
        drawPlayfield($<HTMLCanvasElement>('r-preview'), { notes: state.result.notes, keys: state.result.report.keys, time: now, speed: 0.9 * Number(speed), laneWidth: 58 });
        $('r-time').textContent = `${fmt(now)} / ${fmt(audio.durationMs)}`;
      }
    }
  };
  requestAnimationFrame(frame);

  const wave = $<HTMLCanvasElement>('st-wave');
  const drawWave = () => {
    const env = audio.envelope;
    const dpr = window.devicePixelRatio || 1;
    const W = wave.clientWidth, H = wave.clientHeight;
    if (wave.width !== W * dpr || wave.height !== H * dpr) { wave.width = W * dpr; wave.height = H * dpr; }
    const ctx = wave.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!env || !audio.durationMs) return;
    const bars = Math.floor(W / 3);
    const per = env.length / bars;
    const played = audio.now() / audio.durationMs;
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#ff5fa8');
    grad.addColorStop(1, '#8a6cff');
    for (let i = 0; i < bars; i++) {
      let m = 0;
      for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) m = Math.max(m, env[j] ?? 0);
      const h = Math.max(2, m * (H - 4));
      ctx.fillStyle = i / bars <= played ? grad : 'rgba(255,255,255,0.18)';
      ctx.fillRect(i * 3, (H - h) / 2, 2, h);
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(Math.round(played * W), 0, 1.5, H);
  };

  // remember the player's usual settings (keys, stars, style, engine) in this browser
  const PREFS = 'maniamap.studio.v1';
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) ?? '{}');
    if (KEY_CHIPS.includes(p.keys)) state.keys = p.keys;
    if (p.stars >= 0.5 && p.stars <= 12.5) slider.value = String(p.stars);
    if (typeof p.style === 'string' && (p.style === 'auto' || p.style in STYLES)) state.style = p.style;
    if (p.engine === 'builtin' || p.engine === 'ai' || p.engine === 'mug') preferredEngine = p.engine;
  } catch { /* storage unavailable */ }
  const savePrefs = () => {
    try { localStorage.setItem(PREFS, JSON.stringify({ keys: state.keys, stars: state.stars, style: state.style, engine: state.engine })); } catch { /* storage unavailable */ }
  };
  keyBox.addEventListener('click', savePrefs);
  slider.addEventListener('change', savePrefs);
  styleBox.addEventListener('click', savePrefs);
  document.querySelectorAll('#st-engine button').forEach((b) => b.addEventListener('click', () => setTimeout(savePrefs)));

  renderKeys();
  renderStars();
  renderStyles();
  renderMapset();
  updateCta();
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
