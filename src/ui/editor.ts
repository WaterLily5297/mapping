import {
  type Beatmap, type Note, cloneBeatmap, getKeys, isLN, makeNote, sortNotes,
} from '../core/beatmap';
import { gridTicks, tickColor, snapTime, stepTime, redLineAt, svAt } from '../core/timing';
import type { AudioPlayer } from './audio';
import { type PatternResult, PATTERN_INFO } from '../analysis/patterns';

export type Mode = 'select' | 'note' | 'hold';

const SNAP_DIVS = [1, 2, 3, 4, 6, 8, 12, 16];
const SNAP_COLORS: Record<number, string> = {
  1: '#ff4d4d', 2: '#4d8dff', 3: '#b25dff', 4: '#ffd84d', 6: '#ff7ad9', 8: '#ff9b3d', 12: '#3de0ff', 16: '#5dff7a',
};

/** Classic mania column colours, symmetric around the centre, for any key count. */
export function columnColor(c: number, keys: number): string {
  const mid = (keys - 1) / 2;
  if (keys % 2 === 1 && c === mid) return '#ffd84d';
  const d = Math.floor(Math.abs(c - mid) - (keys % 2 === 1 ? 1 : 0.5));
  return d % 2 === 0 ? '#e8ecf4' : '#5aa9ff';
}

/** Default live-mapping keys: centred slice of the home row (two rows for > 10 keys). */
export function defaultLayout(keys: number): string {
  const presets: Record<number, string> = { 1: 'j', 2: 'fj', 3: 'fgj', 4: 'dfjk', 5: 'dfgjk', 6: 'sdfjkl', 7: 'sdfgjkl', 8: 'asdfjkl;' };
  if (presets[keys]) return presets[keys];
  if (keys <= 10) {
    const row = 'asdfghjkl;';
    const start = Math.floor((10 - keys) / 2);
    return row.slice(start, start + keys);
  }
  // 11K..18K: top row + home row
  return 'qwertyuiopasdfghjkl;'.slice(0, keys);
}

interface Snapshot { map: Beatmap }

export class Editor {
  map: Beatmap;
  selected = new Set<Note>();
  mode: Mode = 'note';
  divisor = 4;
  /** pixels per millisecond (zoom) */
  pxPerMs = 0.45;
  colorBySnap = false;
  showWaveform = true;
  hitTicks = true;
  /** latest pattern classification (set by the Patterns panel) and whether to draw its lane */
  patterns: PatternResult | null = null;
  showPatterns = true;
  live = false;
  layout = defaultLayout(4);
  /** range for range-based tools (auto-map into range) */
  rangeA: number | null = null;
  rangeB: number | null = null;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private clipboard: Note[] = [];
  private drag:
    | { kind: 'move'; startT: number; startCol: number; before: Beatmap; orig: Map<Note, { time: number; endTime?: number; column: number }>; anchor: Note }
    | { kind: 'box'; t0: number; c0: number; t1: number; c1: number; additive: boolean }
    | { kind: 'hold'; note: Note; before: Beatmap }
    | null = null;
  private hover: { t: number; col: number } | null = null;
  private liveDown = new Map<string, Note>();
  private lastNow = 0;
  private overviewCache: { key: string; hist: Float32Array } | null = null;

  onChange: () => void = () => {};
  onStatus: (msg: string) => void = () => {};

  constructor(
    map: Beatmap,
    readonly audio: AudioPlayer,
    readonly canvas: HTMLCanvasElement,
    readonly overview: HTMLCanvasElement,
  ) {
    this.map = map;
    this.layout = defaultLayout(getKeys(map));
    this.bindInput();
    const loop = () => { if (this.active) this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  /** false while another view is shown: no drawing, no keyboard */
  active = true;

  get keys(): number { return getKeys(this.map); }

  // ------------------------------------------------------------ history

  /** Replace the map (e.g. after a tool). Pushes undo. */
  commit(next: Beatmap, label = 'edit'): void {
    this.undoStack.push({ map: this.map });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.map = next;
    this.selected.clear();
    this.afterChange(label);
  }

  /** Snapshot before an in-place mutation, then call afterChange. */
  private checkpoint(): void {
    this.undoStack.push({ map: cloneBeatmap(this.map) });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  private afterChange(label: string): void {
    if (this.layout.length !== this.keys) this.layout = defaultLayout(this.keys);
    this.overviewCache = null;
    this.onStatus(label);
    this.onChange();
  }

  undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push({ map: this.map });
    this.map = s.map;
    this.selected.clear();
    this.afterChange('undo');
  }

  redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push({ map: this.map });
    this.map = s.map;
    this.selected.clear();
    this.afterChange('redo');
  }

  /** load a different map without undo (file open) */
  load(map: Beatmap): void {
    this.map = map;
    this.undoStack = [];
    this.redoStack = [];
    this.selected.clear();
    this.afterChange('loaded');
  }

  // ------------------------------------------------------------ geometry

  private get dpr() { return window.devicePixelRatio || 1; }
  private get W() { return this.canvas.clientWidth; }
  private get H() { return this.canvas.clientHeight; }
  get judgeY() { return this.H - 110; }
  get colW() {
    const avail = this.W - 40 - (this.showWaveform ? 90 : 0);
    return Math.max(14, Math.min(70, Math.floor(avail / this.keys)));
  }
  get fieldX() {
    const total = this.colW * this.keys + (this.showWaveform ? 90 : 0);
    return Math.max(20, Math.floor((this.W - total) / 2));
  }
  get noteH() { return Math.max(8, Math.min(18, this.colW * 0.32)); }

  timeToY(t: number, now = this.audio.now()): number { return this.judgeY - (t - now) * this.pxPerMs; }
  yToTime(y: number, now = this.audio.now()): number { return now + (this.judgeY - y) / this.pxPerMs; }
  xToCol(x: number): number { return Math.floor((x - this.fieldX) / this.colW); }

  private snapped(t: number): number {
    return redLineAt(this.map, t) ? snapTime(this.map, t, this.divisor) : Math.round(t);
  }

  private noteAt(x: number, y: number): Note | undefined {
    const col = this.xToCol(x);
    if (col < 0 || col >= this.keys) return undefined;
    const now = this.audio.now();
    const t = this.yToTime(y, now);
    const tol = this.noteH / this.pxPerMs;
    let best: Note | undefined;
    for (const n of this.map.notes) {
      if (n.column !== col) continue;
      const end = isLN(n) ? n.endTime! : n.time;
      if (t >= n.time - 2 && t <= end + tol) {
        if (!best || Math.abs(n.time - t) < Math.abs(best.time - t)) best = n;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ editing ops

  deleteSelected(): void {
    if (!this.selected.size) return;
    this.checkpoint();
    this.map.notes = this.map.notes.filter((n) => !this.selected.has(n));
    const c = this.selected.size;
    this.selected.clear();
    this.afterChange(`deleted ${c} notes`);
  }

  selectAll(): void {
    this.selected = new Set(this.map.notes);
    this.onChange();
  }

  copy(cut = false): void {
    this.clipboard = sortNotes([...this.selected].map((n) => ({ ...n })));
    if (cut) this.deleteSelected();
    this.onStatus(`${cut ? 'cut' : 'copied'} ${this.clipboard.length} notes`);
  }

  paste(): void {
    if (!this.clipboard.length) return;
    const base = this.clipboard[0].time;
    const at = this.snapped(this.audio.now());
    this.checkpoint();
    const added = this.clipboard
      .filter((n) => n.column < this.keys)
      .map((n) => ({ ...n, time: n.time - base + at, endTime: n.endTime !== undefined ? n.endTime - base + at : undefined }));
    // replace notes that would collide
    const occupied = new Set(added.map((n) => `${n.column}@${n.time}`));
    this.map.notes = sortNotes([...this.map.notes.filter((n) => !occupied.has(`${n.column}@${n.time}`)), ...added]);
    this.selected = new Set(added);
    this.afterChange(`pasted ${added.length} notes`);
  }

  flipSelection(): void {
    if (!this.selected.size) return;
    this.checkpoint();
    for (const n of this.selected) n.column = this.keys - 1 - n.column;
    this.afterChange('mirrored selection');
  }

  /** Apply a whole-map transform only to the selected notes (or to everything if none are selected). */
  applyTool(label: string, fn: (m: Beatmap) => Beatmap): void {
    if (!this.selected.size) {
      this.commit(fn(this.map), label);
      return;
    }
    const sub = cloneBeatmap(this.map);
    sub.notes = this.map.notes.filter((n) => this.selected.has(n)).map((n) => ({ ...n }));
    const res = fn(sub);
    const next = cloneBeatmap(this.map);
    next.notes = sortNotes([
      ...this.map.notes.filter((n) => !this.selected.has(n)).map((n) => ({ ...n })),
      ...res.notes,
    ]);
    this.commit(next, `${label} (selection)`);
    this.selected = new Set(res.notes.map((r) => next.notes.find((n) => n.time === r.time && n.column === r.column)!).filter(Boolean));
  }

  seek(t: number): void { this.audio.seek(t); }

  step(dir: 1 | -1, mult = 1): void {
    let t = this.audio.now();
    for (let i = 0; i < mult; i++) t = redLineAt(this.map, t) ? stepTime(this.map, t, this.divisor, dir) : t + dir * 100;
    this.seek(Math.max(0, t));
  }

  zoom(f: number): void { this.pxPerMs = Math.max(0.05, Math.min(3, this.pxPerMs * f)); }

  // ------------------------------------------------------------ input

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      else this.step(e.deltaY < 0 ? 1 : -1, e.shiftKey ? 4 : 1);
    }, { passive: false });

    c.addEventListener('mousedown', (e) => {
      c.focus();
      const { x, y } = this.pos(e);
      const now = this.audio.now();
      const t = this.yToTime(y, now);
      const col = this.xToCol(x);
      const hit = this.noteAt(x, y);

      if (e.button === 2) {
        if (hit) {
          this.checkpoint();
          const targets = this.selected.has(hit) ? [...this.selected] : [hit];
          this.map.notes = this.map.notes.filter((n) => !targets.includes(n));
          targets.forEach((n) => this.selected.delete(n));
          this.afterChange(`deleted ${targets.length}`);
        }
        return;
      }
      if (e.button !== 0) return;

      if (hit) {
        if (e.ctrlKey) {
          if (this.selected.has(hit)) this.selected.delete(hit); else this.selected.add(hit);
        } else if (!this.selected.has(hit)) {
          if (!e.shiftKey) this.selected.clear();
          this.selected.add(hit);
        }
        const orig = new Map([...this.selected].map((n) => [n, { time: n.time, endTime: n.endTime, column: n.column }]));
        this.drag = { kind: 'move', startT: this.snapped(t), startCol: col, before: cloneBeatmap(this.map), orig, anchor: hit };
        this.onChange();
        return;
      }

      if (this.mode === 'select' || col < 0 || col >= this.keys) {
        this.drag = { kind: 'box', t0: t, c0: col, t1: t, c1: col, additive: e.shiftKey || e.ctrlKey };
        if (!this.drag.additive) this.selected.clear();
        return;
      }

      const st = this.snapped(t);
      const before = cloneBeatmap(this.map);
      const n = makeNote(st, col);
      this.map.notes.push(n);
      sortNotes(this.map.notes);
      if (this.mode === 'hold') {
        n.endTime = st;
        this.drag = { kind: 'hold', note: n, before };
      } else {
        this.pushUndo(before);
        this.afterChange('note');
      }
    });

    window.addEventListener('mousemove', (e) => {
      const { x, y } = this.pos(e);
      const t = this.yToTime(y);
      const col = this.xToCol(x);
      this.hover = col >= 0 && col < this.keys && y > 0 && y < this.H ? { t: this.snapped(t), col } : null;
      const d = this.drag;
      if (!d) return;
      if (d.kind === 'box') {
        d.t1 = t;
        d.c1 = col;
      } else if (d.kind === 'hold') {
        d.note.endTime = Math.max(d.note.time, this.snapped(t));
      } else if (d.kind === 'move') {
        const dt = this.snapped(t) - d.startT;
        const dc = col - d.startCol;
        const cols = [...d.orig.values()].map((o) => o.column);
        const minC = Math.min(...cols);
        const maxC = Math.max(...cols);
        const dcc = Math.max(-minC, Math.min(this.keys - 1 - maxC, dc));
        for (const [n, o] of d.orig) {
          n.time = o.time + dt;
          n.endTime = o.endTime !== undefined ? o.endTime + dt : undefined;
          n.column = o.column + dcc;
        }
      }
    });

    window.addEventListener('mouseup', () => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.kind === 'box') {
        const [ta, tb] = [Math.min(d.t0, d.t1), Math.max(d.t0, d.t1)];
        const [ca, cb] = [Math.min(d.c0, d.c1), Math.max(d.c0, d.c1)];
        for (const n of this.map.notes) {
          if (n.column >= ca && n.column <= cb && n.time >= ta && n.time <= tb) this.selected.add(n);
        }
        this.onChange();
      } else if (d.kind === 'hold') {
        const n = d.note;
        const minLen = (redLineAt(this.map, n.time)?.beatLength ?? 500) / this.divisor;
        if ((n.endTime ?? 0) - n.time < minLen) n.endTime = Math.round(n.time + minLen);
        this.pushUndo(d.before);
        this.afterChange('long note');
      } else if (d.kind === 'move') {
        const moved = [...d.orig].some(([n, o]) => n.time !== o.time || n.column !== o.column);
        if (moved) {
          sortNotes(this.map.notes);
          this.pushUndo(d.before);
          this.afterChange(`moved ${d.orig.size}`);
        }
      }
    });

    window.addEventListener('keydown', (e) => { if (this.active) this.onKey(e, true); });
    window.addEventListener('keyup', (e) => { if (this.active) this.onKey(e, false); });
  }

  private pushUndo(before: Beatmap): void {
    this.undoStack.push({ map: before });
    this.redoStack = [];
  }

  private pos(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;

    // live mapping: layout keys place notes at the (snapped) playback time; hold for LNs
    if (this.live && !ctrl && !e.altKey) {
      const col = this.layout.indexOf(k);
      if (col >= 0 && col < this.keys) {
        e.preventDefault();
        if (down && !e.repeat) {
          const t = this.snapped(this.audio.now());
          if (this.map.notes.some((n) => n.column === col && n.time === t)) return;
          this.checkpoint();
          const n = makeNote(t, col);
          this.map.notes.push(n);
          sortNotes(this.map.notes);
          this.liveDown.set(k, n);
          this.afterChange('live note');
        } else if (!down) {
          const n = this.liveDown.get(k);
          this.liveDown.delete(k);
          if (n) {
            const beat = redLineAt(this.map, n.time)?.beatLength ?? 500;
            const end = this.snapped(this.audio.now());
            if (end - n.time >= beat / 2) { n.endTime = end; this.afterChange('live LN'); }
          }
        }
        return;
      }
    }
    if (!down) return;

    if (k === ' ') { e.preventDefault(); void this.audio.toggle(); return; }
    if (k === 'tab') { e.preventDefault(); this.live = !this.live; this.onStatus(this.live ? `live mapping ON — keys: ${this.layout}` : 'live mapping off'); this.onChange(); return; }
    if (ctrl && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (ctrl && k === 'y') { e.preventDefault(); this.redo(); return; }
    if (ctrl && k === 'a') { e.preventDefault(); this.selectAll(); return; }
    if (ctrl && k === 'c') { e.preventDefault(); this.copy(); return; }
    if (ctrl && k === 'x') { e.preventDefault(); this.copy(true); return; }
    if (ctrl && k === 'v') { e.preventDefault(); this.paste(); return; }
    if (ctrl && k === 'h') { e.preventDefault(); this.flipSelection(); return; }
    if (ctrl) return;
    if (k === 'delete' || k === 'backspace') { e.preventDefault(); this.deleteSelected(); return; }
    if (k === 'escape') { this.selected.clear(); this.onChange(); return; }
    if (k === '1') { this.mode = 'select'; this.onChange(); return; }
    if (k === '2') { this.mode = 'note'; this.onChange(); return; }
    if (k === '3') { this.mode = 'hold'; this.onChange(); return; }
    if (k === 'arrowup') { e.preventDefault(); this.step(1, e.shiftKey ? 4 : 1); return; }
    if (k === 'arrowdown') { e.preventDefault(); this.step(-1, e.shiftKey ? 4 : 1); return; }
    if (k === 'pageup') { e.preventDefault(); this.step(1, this.divisor * 4); return; }
    if (k === 'pagedown') { e.preventDefault(); this.step(-1, this.divisor * 4); return; }
    if (k === 'home') { this.seek(0); return; }
    if (k === 'end') { this.seek(this.audio.durationMs || this.lastNoteTime()); return; }
    if (k === '+' || k === '=') { this.zoom(1.15); return; }
    if (k === '-') { this.zoom(1 / 1.15); return; }
    if (k === '[' || k === ']') {
      const i = SNAP_DIVS.indexOf(this.divisor);
      this.divisor = SNAP_DIVS[Math.max(0, Math.min(SNAP_DIVS.length - 1, i + (k === ']' ? 1 : -1)))];
      this.onChange();
    }
  }

  lastNoteTime(): number {
    return this.map.notes.reduce((m, n) => Math.max(m, n.endTime ?? n.time), 0);
  }

  // ------------------------------------------------------------ drawing

  private resize(cv: HTMLCanvasElement): CanvasRenderingContext2D {
    const dpr = this.dpr;
    const w = Math.round(cv.clientWidth * dpr);
    const h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  private draw(): void {
    const ctx = this.resize(this.canvas);
    const W = this.W, H = this.H;
    const now = this.audio.now();
    const K = this.keys;
    const cw = this.colW;
    const fx = this.fieldX;
    const jy = this.judgeY;
    const tTop = this.yToTime(0, now);
    const tBottom = this.yToTime(H, now);

    // hit ticks while playing
    if (this.audio.playing && this.hitTicks && now > this.lastNow) {
      const prev = this.lastNow;
      if (this.map.notes.some((n) => n.time > prev && n.time <= now)) this.audio.tick();
    }
    this.lastNow = now;

    ctx.fillStyle = '#0a0c11';
    ctx.fillRect(0, 0, W, H);

    // range highlight
    if (this.rangeA !== null || this.rangeB !== null) {
      const a = this.rangeA ?? 0;
      const b = this.rangeB ?? this.lastNoteTime();
      ctx.fillStyle = 'rgba(138,108,255,0.10)';
      const y1 = this.timeToY(Math.max(a, b), now), y2 = this.timeToY(Math.min(a, b), now);
      ctx.fillRect(fx, y1, cw * K, y2 - y1);
    }

    // columns
    for (let c = 0; c < K; c++) {
      ctx.fillStyle = c % 2 ? '#141822' : '#11141c';
      ctx.fillRect(fx + c * cw, 0, cw, H);
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      ctx.fillRect(fx + c * cw, 0, 1, H);
    }
    ctx.fillRect(fx + K * cw - 1, 0, 1, H);

    // grid
    const ticks = gridTicks(this.map, tBottom, tTop, this.divisor);
    for (const tk of ticks) {
      const y = Math.round(this.timeToY(tk.time, now)) + 0.5;
      ctx.strokeStyle = tickColor(tk.kind);
      ctx.globalAlpha = tk.kind === 0 ? 0.9 : tk.kind === 1 ? 0.55 : 0.35;
      ctx.lineWidth = tk.kind === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(fx, y);
      ctx.lineTo(fx + cw * K, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // timing points markers
    for (const tp of this.map.timingPoints) {
      if (tp.time < tBottom || tp.time > tTop) continue;
      const y = this.timeToY(tp.time, now);
      ctx.fillStyle = tp.uninherited ? '#ff4d4d' : '#3ddc84';
      ctx.fillRect(fx - 24, y - 1, 10, 3);
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(tp.uninherited ? `${+(60000 / tp.beatLength).toFixed(2)}` : `${(-100 / tp.beatLength).toFixed(2)}x`, fx - 26, y + 3);
    }

    // pattern lane: coloured bar left of the playfield + label at each section start
    if (this.showPatterns && this.patterns) {
      ctx.textAlign = 'right';
      ctx.font = '11px system-ui, sans-serif';
      for (const sec of this.patterns.sections) {
        const lastRowT = this.patterns.rows[sec.lastRow].time;
        if (lastRowT < tBottom || sec.start > tTop) continue;
        const info = PATTERN_INFO[sec.type];
        const y1 = this.timeToY(lastRowT, now) - this.noteH;
        const y2 = this.timeToY(sec.start, now);
        ctx.fillStyle = info.color;
        ctx.fillRect(fx - 9, y1, 6, Math.max(2, y2 - y1));
        if (fx > 110) {
          const ly = Math.min(Math.max(y2, 14), jy - 4);
          ctx.fillText(info.name, fx - 14, ly - 2);
          ctx.fillStyle = '#8a94a8';
          ctx.font = '10px system-ui, sans-serif';
          ctx.fillText(sec.speed, fx - 14, ly + 10);
          ctx.font = '11px system-ui, sans-serif';
        }
      }
    }

    // waveform
    if (this.showWaveform && this.audio.envelope) {
      const env = this.audio.envelope;
      const wx = fx + cw * K + 8;
      const ww = 80;
      ctx.fillStyle = '#0e1118';
      ctx.fillRect(wx, 0, ww, H);
      const wg = ctx.createLinearGradient(wx, 0, wx + ww, 0);
      wg.addColorStop(0, 'rgba(255,95,168,0.75)');
      wg.addColorStop(0.5, 'rgba(176,102,255,0.9)');
      wg.addColorStop(1, 'rgba(138,108,255,0.75)');
      ctx.fillStyle = wg;
      const per = 5; // ENVELOPE_MS
      for (let y = 0; y < H; y++) {
        const t = this.yToTime(y, now);
        const i = Math.floor(t / per);
        if (i < 0 || i >= env.length) continue;
        let v = 0;
        const span = Math.max(1, Math.ceil(1 / this.pxPerMs / per));
        for (let j = i; j < Math.min(env.length, i + span); j++) v = Math.max(v, env[j]);
        const w = v * ww;
        ctx.fillRect(wx + (ww - w) / 2, y, w, 1);
      }
    }

    // notes
    const nh = this.noteH;
    const pad = Math.max(1, Math.floor(cw * 0.06));
    for (const n of this.map.notes) {
      const end = n.endTime ?? n.time;
      if (end < tBottom - 50 || n.time > tTop + 50) continue;
      const x = fx + n.column * cw + pad;
      const w = cw - pad * 2;
      const y = this.timeToY(n.time, now);
      const color = this.colorBySnap ? snapColor(this.map, n.time) : columnColor(n.column, K);
      const sel = this.selected.has(n);
      if (isLN(n)) {
        const ye = this.timeToY(n.endTime!, now);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.32;
        roundRect(ctx, x + w * 0.14, ye, w * 0.72, Math.max(0, y - ye - nh / 2), 4);
        ctx.fill();
        ctx.globalAlpha = 0.95;
        roundRect(ctx, x + 2, ye - 3, w - 4, 4, 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      const grad = ctx.createLinearGradient(0, y - nh, 0, y);
      grad.addColorStop(0, color);
      grad.addColorStop(1, shadeHex(color, -0.28));
      ctx.fillStyle = grad;
      roundRect(ctx, x, y - nh, w, nh, Math.min(4, nh / 2));
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(x + 3, y - nh + 1.5, w - 6, 1);
      if (sel) {
        ctx.save();
        ctx.strokeStyle = '#ff5fa8';
        ctx.shadowColor = '#ff5fa8';
        ctx.shadowBlur = 10;
        ctx.lineWidth = 2;
        const ye = isLN(n) ? this.timeToY(n.endTime!, now) - 3 : y - nh;
        roundRect(ctx, x - 1.5, ye - 1.5, w + 3, y - ye + 3, 5);
        ctx.stroke();
        ctx.restore();
      }
    }

    // hover ghost
    if (this.hover && !this.drag && this.mode !== 'select' && !this.audio.playing) {
      const { t, col } = this.hover;
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = columnColor(col, K);
      roundRect(ctx, fx + col * cw + pad, this.timeToY(t, now) - nh, cw - pad * 2, nh, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // box selection
    if (this.drag?.kind === 'box') {
      const d = this.drag;
      const x1 = fx + Math.max(0, Math.min(d.c0, d.c1)) * cw;
      const x2 = fx + (Math.min(K - 1, Math.max(d.c0, d.c1)) + 1) * cw;
      const y1 = this.timeToY(Math.max(d.t0, d.t1), now), y2 = this.timeToY(Math.min(d.t0, d.t1), now);
      ctx.fillStyle = 'rgba(255,95,168,0.10)';
      ctx.strokeStyle = '#ff5fa8';
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1, y2 - y1);
    }

    // judgement line + key labels
    ctx.fillStyle = '#0a0c11';
    ctx.fillRect(fx, jy + 2, cw * K, H - jy);
    const jl = ctx.createLinearGradient(fx, 0, fx + cw * K, 0);
    jl.addColorStop(0, 'rgba(255,95,168,0.35)');
    jl.addColorStop(0.5, '#ff5fa8');
    jl.addColorStop(1, 'rgba(138,108,255,0.5)');
    ctx.save();
    ctx.shadowColor = '#ff5fa8';
    ctx.shadowBlur = 12;
    ctx.fillStyle = jl;
    ctx.fillRect(fx, jy, cw * K, 2);
    ctx.restore();
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (let c = 0; c < K; c++) {
      ctx.fillStyle = columnColor(c, K);
      ctx.globalAlpha = 0.14;
      roundRect(ctx, fx + c * cw + 3, jy + 8, cw - 6, 26, 6);
      ctx.fill();
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = columnColor(c, K);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#c9d1e0';
      ctx.fillText(this.live ? (this.layout[c] ?? '').toUpperCase() : String(c + 1), fx + c * cw + cw / 2, jy + 25);
    }

    // time readout
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8b93a7';
    ctx.font = '12px "JetBrains Mono", ui-monospace, monospace';
    const sv = svAt(this.map, now);
    ctx.fillText(`${fmtTime(now)}  ${Math.round(now)}ms  1/${this.divisor}  ${this.mode}${this.live ? '  LIVE' : ''}${sv !== 1 ? `  SV ${sv.toFixed(2)}x` : ''}`, 10, H - 14);

    this.drawOverview(now, tBottom, tTop);
  }

  private drawOverview(now: number, tBottom: number, tTop: number): void {
    const cv = this.overview;
    const ctx = this.resize(cv);
    const W = cv.clientWidth, H = cv.clientHeight;
    const total = Math.max(this.audio.durationMs, this.lastNoteTime() + 1000, 1000);
    const key = `${this.map.notes.length}:${this.lastNoteTime()}:${total}:${H}`;
    if (!this.overviewCache || this.overviewCache.key !== key) {
      const bins = Math.max(1, Math.floor(H / 2));
      const hist = new Float32Array(bins);
      for (const n of this.map.notes) hist[Math.min(bins - 1, Math.floor((n.time / total) * bins))]++;
      const max = Math.max(1, ...hist);
      for (let i = 0; i < bins; i++) hist[i] /= max;
      this.overviewCache = { key, hist };
    }
    const hist = this.overviewCache.hist;
    ctx.fillStyle = '#0e1118';
    ctx.fillRect(0, 0, W, H);
    const bh = H / hist.length;
    for (let i = 0; i < hist.length; i++) {
      const v = hist[i];
      ctx.fillStyle = v > 0.8 ? '#ff5fa8' : v > 0.55 ? '#b066ff' : '#4f7dff';
      ctx.fillRect(0, H - (i + 1) * bh, v * (W - 10), Math.ceil(bh));
    }
    const yOf = (t: number) => H - (t / total) * H;
    if (this.showPatterns && this.patterns) {
      for (const sec of this.patterns.sections) {
        ctx.fillStyle = PATTERN_INFO[sec.type].color;
        const y1 = yOf(this.patterns.rows[sec.lastRow].time + 1);
        ctx.fillRect(W - 8, y1, 8, Math.max(1, yOf(sec.start) - y1));
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, yOf(tTop), W, Math.max(2, yOf(tBottom) - yOf(tTop)));
    ctx.fillStyle = '#ff5fa8';
    ctx.fillRect(0, yOf(now) - 1, W, 2);
    if (!cv.dataset.bound) {
      cv.dataset.bound = '1';
      const seekTo = (e: MouseEvent) => {
        const r = cv.getBoundingClientRect();
        const tot = Math.max(this.audio.durationMs, this.lastNoteTime() + 1000, 1000);
        this.seek(((r.bottom - e.clientY) / r.height) * tot);
      };
      cv.addEventListener('mousedown', (e) => {
        seekTo(e);
        const mv = (ev: MouseEvent) => seekTo(ev);
        window.addEventListener('mousemove', mv);
        window.addEventListener('mouseup', () => window.removeEventListener('mousemove', mv), { once: true });
      });
    }
  }
}

export function snapColor(map: Beatmap, t: number): string {
  if (!redLineAt(map, t)) return '#888';
  for (const d of SNAP_DIVS) if (Math.abs(snapTime(map, t, d) - t) <= 1) return SNAP_COLORS[d];
  return '#888';
}

export function fmtTime(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
}

function shadeHex(col: string, amt: number): string {
  if (!col.startsWith('#') || col.length !== 7) return col;
  const ch = (i: number) => Math.max(0, Math.min(255, Math.round(parseInt(col.slice(i, i + 2), 16) * (1 + amt))));
  return `rgb(${ch(1)},${ch(3)},${ch(5)})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
