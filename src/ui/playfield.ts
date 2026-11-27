/** A good-looking falling-notes playfield (osu!mania style) for previews. */
import type { Note } from '../core/beatmap';
import { columnColor } from './editor';

export interface PlayfieldView {
  notes: Note[];
  keys: number;
  /** song time in ms at the judgement line */
  time: number;
  /** pixels per ms */
  speed: number;
  /** lane width in px (clamped to the canvas) */
  laneWidth?: number;
  /** draw receptors / key lights */
  receptors?: boolean;
  /** fade the top so notes appear softly */
  fadeTop?: boolean;
}

const rr = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  const q = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + q, y);
  ctx.arcTo(x + w, y, x + w, y + h, q);
  ctx.arcTo(x + w, y + h, x, y + h, q);
  ctx.arcTo(x, y + h, x, y, q);
  ctx.arcTo(x, y, x + w, y, q);
  ctx.closePath();
};

/** Sorted notes -> index of the first note that may be visible (binary search on end time). */
function firstVisible(notes: Note[], t: number): number {
  let lo = 0, hi = notes.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (notes[m].time < t) lo = m + 1; else hi = m; }
  return Math.max(0, lo - 64); // LNs that started earlier may still be visible
}

export function drawPlayfield(canvas: HTMLCanvasElement, v: PlayfieldView): void {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const K = v.keys;
  const lane = Math.max(8, Math.min(v.laneWidth ?? 64, (W - 24) / K));
  const fieldW = lane * K;
  const x0 = Math.round((W - fieldW) / 2);
  const hitY = H - (v.receptors === false ? 8 : Math.min(72, H * 0.14));

  // field background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, 'rgba(14,16,24,0.0)');
  bg.addColorStop(0.35, 'rgba(14,16,24,0.85)');
  bg.addColorStop(1, 'rgba(10,12,18,0.98)');
  ctx.fillStyle = bg;
  ctx.fillRect(x0, 0, fieldW, H);
  for (let c = 0; c < K; c++) {
    if (c % 2) { ctx.fillStyle = 'rgba(255,255,255,0.018)'; ctx.fillRect(x0 + c * lane, 0, lane, H); }
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(x0 + c * lane, 0, 1, H);
  }
  ctx.fillRect(x0 + fieldW - 1, 0, 1, H);

  // notes
  const notes = v.notes;
  const tTop = v.time + hitY / v.speed;
  const pad = Math.max(1.5, lane * 0.06);
  const noteH = Math.max(6, Math.min(16, lane * 0.26));
  const lit = new Array<number>(K).fill(0);
  for (let i = firstVisible(notes, v.time - 2000); i < notes.length; i++) {
    const n = notes[i];
    if (n.time > tTop + 50) break;
    const end = n.endTime ?? n.time;
    if (end < v.time - 200) {
      continue;
    }
    const x = x0 + n.column * lane + pad;
    const w = lane - pad * 2;
    const yHead = hitY - (n.time - v.time) * v.speed;
    const col = columnColor(n.column, K);
    const since = v.time - n.time;
    if (since >= 0 && since < 140) lit[n.column] = Math.max(lit[n.column], 1 - since / 140);
    if (n.endTime !== undefined && n.endTime > n.time) {
      const yTail = hitY - (n.endTime - v.time) * v.speed;
      const yH = Math.min(hitY, yHead);
      if (v.time >= n.time && v.time <= n.endTime) lit[n.column] = 1;
      ctx.globalAlpha = 0.38;
      ctx.fillStyle = col;
      rr(ctx, x + w * 0.12, yTail, w * 0.76, Math.max(0, yH - yTail), 4);
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x + w * 0.12, yTail, w * 0.76, 2);
      ctx.globalAlpha = 1;
      if (v.time > n.time) continue; // head already hit: only the body remains
    } else if (since > 0) continue;
    const g = ctx.createLinearGradient(0, yHead - noteH, 0, yHead);
    g.addColorStop(0, col);
    g.addColorStop(1, shade(col, -0.25));
    ctx.shadowColor = col;
    ctx.shadowBlur = 10;
    ctx.fillStyle = g;
    rr(ctx, x, yHead - noteH, w, noteH, Math.min(5, noteH / 2));
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(x + 3, yHead - noteH + 2, w - 6, 1.5);
  }

  // judgement line
  const jl = ctx.createLinearGradient(x0, 0, x0 + fieldW, 0);
  jl.addColorStop(0, 'rgba(255,95,168,0.2)');
  jl.addColorStop(0.5, 'rgba(255,95,168,1)');
  jl.addColorStop(1, 'rgba(138,108,255,0.2)');
  ctx.shadowColor = '#ff5fa8';
  ctx.shadowBlur = 12;
  ctx.fillStyle = jl;
  ctx.fillRect(x0, hitY - 1, fieldW, 2);
  ctx.shadowBlur = 0;

  // receptors
  if (v.receptors !== false) {
    for (let c = 0; c < K; c++) {
      const x = x0 + c * lane + pad;
      const w = lane - pad * 2;
      const col = columnColor(c, K);
      if (lit[c] > 0) {
        const beam = ctx.createLinearGradient(0, hitY - 140, 0, hitY);
        beam.addColorStop(0, 'rgba(255,255,255,0)');
        beam.addColorStop(1, withAlpha(col, 0.28 * lit[c]));
        ctx.fillStyle = beam;
        ctx.fillRect(x0 + c * lane, hitY - 140, lane, 140);
      }
      ctx.fillStyle = lit[c] > 0 ? withAlpha(col, 0.35 + 0.5 * lit[c]) : 'rgba(255,255,255,0.06)';
      rr(ctx, x, hitY + 8, w, Math.max(10, Math.min(28, lane * 0.45)), 6);
      ctx.fill();
      ctx.strokeStyle = withAlpha(col, 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  if (v.fadeTop !== false) {
    const f = ctx.createLinearGradient(0, 0, 0, H * 0.25);
    f.addColorStop(0, 'rgba(11,13,18,1)');
    f.addColorStop(1, 'rgba(11,13,18,0)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = f;
    ctx.fillRect(0, 0, W, H * 0.25);
    ctx.globalCompositeOperation = 'source-over';
  }
}

function parse(col: string): [number, number, number] {
  const h = col.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function withAlpha(col: string, a: number): string {
  const [r, g, b] = parse(col);
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}
function shade(col: string, amt: number): string {
  const [r, g, b] = parse(col).map((x) => Math.max(0, Math.min(255, Math.round(x * (1 + amt)))));
  return `rgb(${r},${g},${b})`;
}
