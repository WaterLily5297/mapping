/**
 * Star rating for osu!mania (any key count) — an independent implementation of
 * "Star Rating Rebirth: A VSRG Difficulty-Rating Framework (Feb 2025 Update)" by [Crz]sunnyxxy
 * (the algorithm behind the community "Sunny rework" star rating), written from the paper:
 *   https://github.com/sunnyxxy/Star-Rating-Rebirth  (Star_Rating_Rebirth.pdf)
 * No code was copied; the reference program was only used to compare results.
 *
 * Seven features are computed on a 1 ms grid and smoothed over ±500 ms:
 *   J̄ same-column pressure (jacks), X̄ cross-column pressure (trills/brackets),
 *   P̄ pressing intensity (density, chords, LN bodies), Ā unevenness, R̄ LN release,
 *   C local note count, K active columns
 * and combined into a difficulty curve D(s); the rating mixes density-weighted 93rd/83rd
 * percentiles with a weighted power mean.
 *
 * The paper covers 1-10K. For 11-18K the cross-column weights are extended with the
 * same pattern (`extrapolated: true` in the result).
 */
import { type Beatmap, getKeys, isLN } from '../core/beatmap';

const LN = 5;      // λn: overall norm
const L1 = 0.11;   // λ1: same-column intercept
const L2 = 6.0;    // λ2: LN body weight
const L3 = 24;     // λ3: synchronous-note penalty
const L4 = 0.8;    // λ4: spacing index weight
const W0 = 0.4, W1 = 2.7, P1 = 1.5, W2 = 0.27, P0 = 1.0;

/** cross-column weights from the paper (index K = 1..10: K+1 values) */
const CROSS: number[][] = [
  [],
  [0.075, 0.075],
  [0.125, 0.05, 0.125],
  [0.125, 0.125, 0.125, 0.125],
  [0.175, 0.25, 0.05, 0.25, 0.175],
  [0.175, 0.25, 0.175, 0.175, 0.25, 0.175],
  [0.225, 0.35, 0.25, 0.05, 0.25, 0.35, 0.225],
  [0.225, 0.35, 0.25, 0.225, 0.225, 0.25, 0.35, 0.225],
  [0.275, 0.45, 0.35, 0.25, 0.05, 0.25, 0.35, 0.45, 0.275],
  [0.275, 0.45, 0.35, 0.25, 0.275, 0.275, 0.25, 0.35, 0.45, 0.275],
  [0.325, 0.55, 0.45, 0.35, 0.25, 0.05, 0.25, 0.35, 0.45, 0.55, 0.325],
];

/** Cross-column weights for any K (11-18K follow the paper's pattern). */
export function crossWeights(K: number): number[] {
  if (K <= 10) return CROSS[K];
  return crossWeightsRule(K);
}

/** The pattern of the paper's table (matches it exactly for 4-10K); used for 11-18K. */
export function crossWeightsRule(K: number): number[] {
  const pairs = Math.floor(K / 2); // weights per half, outer to inner
  const outer = 0.075 + 0.05 * pairs;
  const half: number[] = [outer];
  // second weight is the largest, then steps of 0.1 down to 0.25
  let w = 0.05 + 0.1 * pairs;
  for (let i = 1; i < pairs; i++) { half.push(Math.max(0.25, Math.round(w * 1000) / 1000)); w -= 0.1; }
  const mid = K % 2 === 0 ? [0.05] : [outer, outer];
  return [...half, ...mid, ...half.slice().reverse()].slice(0, K + 1);
}

export interface StarRating {
  stars: number;
  /** difficulty curve D(s) sampled every `step` ms (for graphs), time from the first note */
  curve: Float32Array;
  step: number;
  /** ms of the first sample */
  start: number;
  extrapolated: boolean;
}

interface N3 { k: number; h: number; t: number } // t = -1 for taps

/** Hit leniency x from OD (the paper's q is the two-sided 300 window in seconds). */
function leniency(od: number): number {
  // q = two-sided 300 window in seconds = 2 * (64.5 - ceil(3 * OD)) ms  (OD 8 -> 0.081)
  const q = (2 * (64.5 - Math.ceil(od * 3))) / 1000;
  const base = 0.3 * Math.sqrt(q);
  return Math.min(base, 0.6 * (base - 0.09) + 0.09);
}

export function starRating(map: Beatmap, opts: { rate?: number; curveStep?: number } = {}): StarRating {
  const K = Math.max(1, getKeys(map));
  const rate = opts.rate ?? 1;
  const step = opts.curveStep ?? 100;
  const empty: StarRating = { stars: 0, curve: new Float32Array(0), step, start: 0, extrapolated: K > 10 };
  if (!map.notes.length) return empty;
  const x = leniency(Number(map.difficulty.get('OverallDifficulty') ?? 8));

  // notes in the paper's form, shifted so that time starts at 0 (integer ms)
  const raw = map.notes.map((n) => ({ k: n.column, h: Math.round(n.time / rate), t: isLN(n) ? Math.round(n.endTime! / rate) : -1 }));
  const t0 = Math.min(...raw.map((n) => n.h));
  const notes: N3[] = raw.map((n) => ({ k: n.k, h: n.h - t0, t: n.t < 0 ? -1 : n.t - t0 }))
    .sort((a, b) => a.h - b.h || a.k - b.k || a.t - b.t);
  // keep the map legal: drop notes that start inside another note of the same column
  const legal: N3[] = [];
  const lastEnd = new Array(K).fill(-Infinity);
  for (const n of notes) {
    if (n.k < 0 || n.k >= K) continue;
    if (n.h <= lastEnd[n.k]) continue;
    legal.push(n);
    lastEnd[n.k] = Math.max(n.h, n.t);
  }
  if (!legal.length) return empty;
  const T = Math.max(...legal.map((n) => Math.max(n.h, n.t)));
  const S = T + 1;
  const byCol: N3[][] = Array.from({ length: K }, () => []);
  for (const n of legal) byCol[n.k].push(n);

  // helpers: window sums over [s-500, s+499] with prefix sums
  const smoothSum = (f: Float64Array | Float32Array, out: Float32Array, scale = 0.001) => {
    const pre = new Float64Array(S + 1);
    for (let i = 0; i < S; i++) pre[i + 1] = pre[i] + f[i];
    for (let s = 0; s < S; s++) out[s] = (pre[Math.min(S, s + 500)] - pre[Math.max(0, s - 500)]) * scale;
  };
  const fillConst = (f: Float32Array | Float64Array, a: number, b: number, v: number) => { for (let i = Math.max(0, a); i < Math.min(S, b); i++) f[i] = v; };

  // ---- J̄: same-column pressure (λn norm over columns, weighted by 1/Δk)
  const jNum = new Float64Array(S);
  const jDen = new Float64Array(S);
  {
    const Jk = new Float32Array(S);
    const Jbar = new Float32Array(S);
    const inv = new Float32Array(S);
    for (const col of byCol) {
      if (col.length < 2) continue;
      Jk.fill(0);
      inv.fill(0);
      for (let i = 0; i + 1 < col.length; i++) {
        const hl = col[i].h, hr = col[i + 1].h;
        const d = 0.001 * (hr - hl);
        if (d <= 0) continue;
        const jn = 1 - 7e-5 * Math.pow(0.15 + Math.abs(d - 0.08), -4);
        const v = (1 / d) * (1 / (d + L1 * Math.pow(x, 0.25))) * jn;
        fillConst(Jk, hl, hr, v);
        fillConst(inv, hl, hr, 1 / d);
      }
      smoothSum(Jk, Jbar);
      for (let s = 0; s < S; s++) {
        if (inv[s] > 0) {
          jNum[s] += Math.pow(Math.max(0, Jbar[s]), LN) * inv[s];
          jDen[s] += inv[s];
        }
      }
    }
  }

  // ---- X̄: cross-column pressure between neighbouring columns
  const Xs = new Float32Array(S);
  const Xbar = new Float32Array(S);
  {
    const w = crossWeights(K);
    for (let k = 0; k <= K; k++) {
      if (!w[k]) continue;
      const heads = [...new Set([...(byCol[k - 1] ?? []), ...(byCol[k] ?? [])].map((n) => n.h))].sort((a, b) => a - b);
      for (let i = 0; i + 1 < heads.length; i++) {
        const d = 0.001 * (heads[i + 1] - heads[i]);
        const v = w[k] * 0.16 * Math.pow(Math.max(x, d), -2);
        for (let s = heads[i]; s < heads[i + 1]; s++) Xs[s] += v;
      }
    }
    smoothSum(Xs, Xbar);
  }

  // ---- P̄: pressing intensity
  const Ps = new Float32Array(S);
  const Pbar = new Float32Array(S);
  {
    const headCount = new Map<number, number>();
    for (const n of legal) headCount.set(n.h, (headCount.get(n.h) ?? 0) + 1);
    const heads = [...headCount.keys()].sort((a, b) => a - b);
    const lns = legal.filter((n) => n.t >= 0).sort((a, b) => a.h - b.h);
    const spike = Math.pow(Math.max(0, 0.02 * (4 / x - L3)), 0.25);
    let lnPtr = 0;
    const active: N3[] = [];
    for (let i = 0; i + 1 < heads.length; i++) {
      const hl = heads[i], hr = heads[i + 1];
      const d = 0.001 * (hr - hl);
      // LN bodies overlapping [hl, hr)
      while (lnPtr < lns.length && lns[lnPtr].h < hr) active.push(lns[lnPtr++]);
      let U = 0;
      for (let j = active.length - 1; j >= 0; j--) {
        const n = active[j];
        if (n.t <= hl) { active.splice(j, 1); continue; }
        U += 0.0013 * Math.max(0, Math.min(hr, n.h + 120, n.t) - Math.max(hl, Math.min(n.h + 60, n.t)));
        U += 0.001 * Math.max(0, Math.min(hr, n.t) - Math.max(hl, Math.min(n.h + 120, n.t)));
      }
      const v = 1 + L2 * U;
      const r = 7.5 / d;
      const b = r > 160 && r < 360 ? 1 + 1.7e-7 * (r - 160) * (r - 360) ** 2 : 1;
      const inner = d <= (2 * x) / 3 ? 1 - (L3 / x) * (d - x / 2) ** 2 : 1 - (L3 / x) * (x / 6) ** 2;
      const fp = Math.pow(Math.max(0, (0.08 / d) * inner), 0.25) * b * v;
      fillConst(Ps, hl, hr, fp / d);
    }
    for (const [h, c] of headCount) if (c > 1 && h < S) Ps[h] += 1000 * (c - 1) * spike;
    smoothSum(Ps, Pbar);
  }

  // ---- R̄: LN releases
  const Rs = new Float32Array(S);
  const Rbar = new Float32Array(S);
  {
    const idx: { t: number; I: number }[] = [];
    for (const col of byCol) {
      for (let i = 0; i < col.length; i++) {
        const n = col[i];
        if (n.t < 0) continue;
        const next = col[i + 1];
        const Ih = (0.001 * Math.abs(n.t - n.h - 80)) / x;
        const It = next ? (0.001 * Math.abs(next.h - n.t - 80)) / x : 1e6;
        const I = 2 / (2 + Math.exp(-5 * (Ih - 0.75)) + Math.exp(-5 * (It - 0.75)));
        idx.push({ t: n.t, I });
      }
    }
    idx.sort((a, b) => a.t - b.t);
    for (let i = 0; i + 1 < idx.length; i++) {
      const tl = idx[i].t, tr = idx[i + 1].t;
      if (tr <= tl) continue;
      const d = 0.001 * (tr - tl);
      fillConst(Rs, tl, tr, (0.08 * Math.pow(d, -0.5) / x) * (1 + L4 * (idx[i].I + idx[i + 1].I)));
    }
    smoothSum(Rs, Rbar);
  }

  // ---- Ā (unevenness) and K(s) (active columns): one sweep with a pointer per column
  const As = new Float32Array(S);
  const Ks = new Uint8Array(S);
  {
    const hp = new Array(K).fill(0); // head pointer: col[hp] is the last head <= s
    const ap = new Array(K).fill(0); // active pointer
    const deltas: number[] = new Array(K).fill(Infinity);
    for (let s = 0; s < S; s++) {
      let act = 0;
      let A = 1;
      let prevDelta = NaN;
      for (let k = 0; k < K; k++) {
        const col = byCol[k];
        // Δk(s): spacing of the two heads around s in this column
        while (hp[k] + 1 < col.length && col[hp[k] + 1].h <= s) hp[k]++;
        const l = col[hp[k]], r = col[hp[k] + 1];
        deltas[k] = l && r && l.h <= s && s < r.h ? 0.001 * (r.h - l.h) : Infinity;
        // active: some note with s in [h - 150, max(h, t) + 149]
        while (ap[k] < col.length && Math.max(col[ap[k]].h, col[ap[k]].t) + 149 < s) ap[k]++;
        const c = col[ap[k]];
        if (c && c.h - 150 <= s) {
          act++;
          const d1 = deltas[k];
          if (!Number.isNaN(prevDelta)) {
            const d0 = prevDelta;
            const m = Math.max(d0, d1);
            if (Number.isFinite(m)) {
              const dd = Math.abs(d0 - d1) + 0.4 * Math.max(0, m - 0.11);
              if (dd < 0.02) A *= Math.min(0.75 + 0.5 * m, 1);
              else if (dd < 0.07) A *= Math.min(0.65 + 5 * dd + 0.5 * m, 1);
            }
          }
          prevDelta = d1;
        }
      }
      As[s] = A;
      Ks[s] = Math.max(1, act);
    }
  }
  const Abar = new Float32Array(S);
  {
    const pre = new Float64Array(S + 1);
    for (let i = 0; i < S; i++) pre[i + 1] = pre[i] + As[i];
    for (let s = 0; s < S; s++) {
      const a = Math.max(0, s - 500), b = Math.min(S, s + 500);
      Abar[s] = (pre[b] - pre[a]) / (b - a);
    }
  }

  // ---- C(s): notes with heads in [s-500, s+500)
  const Cs = new Float32Array(S);
  {
    const cnt = new Float64Array(S + 1);
    for (const n of legal) cnt[n.h + 1]++;
    for (let i = 0; i < S; i++) cnt[i + 1] += cnt[i];
    for (let s = 0; s < S; s++) Cs[s] = cnt[Math.min(S, s + 500)] - cnt[Math.max(0, s - 500)];
  }

  // ---- combine: S(s), twist T(s), difficulty D(s)
  const D = new Float32Array(S);
  for (let s = 0; s < S; s++) {
    const J = jDen[s] > 0 ? Math.pow(jNum[s] / jDen[s], 1 / LN) : 0;
    const A = Abar[s];
    const Kk = Ks[s];
    const aJ = Math.pow(A, 3 / Kk) * J;
    const aP = Math.pow(A, 2 / 3) * (0.8 * Pbar[s] + (Rbar[s] * 35) / (Cs[s] + 8));
    const Sv = Math.pow(W0 * Math.pow(aJ, 1.5) + (1 - W0) * Math.pow(aP, 1.5), 2 / 3);
    const Tw = (Math.pow(A, 3 / Kk) * Xbar[s]) / (Xbar[s] + Sv + 1);
    D[s] = W1 * Math.sqrt(Sv) * Math.pow(Tw, P1) + W2 * Sv;
  }

  // ---- density-weighted percentiles and weighted power mean
  const order = Array.from({ length: S }, (_, i) => i).sort((a, b) => D[a] - D[b] || Cs[a] - Cs[b]);
  let totalC = 0;
  for (let s = 0; s < S; s++) totalC += Cs[s];
  const pct = (ps: number[]) => {
    const out: number[] = [];
    let cum = 0;
    let j = 0;
    const targets = [...ps].sort((a, b) => a - b);
    for (const i of order) {
      cum += Cs[i];
      while (j < targets.length && cum / totalC >= targets[j]) { out.push(D[i]); j++; }
      if (j >= targets.length) break;
    }
    while (out.length < targets.length) out.push(D[order[order.length - 1]]);
    return out.reduce((a, b) => a + b, 0) / out.length;
  };
  const D93 = pct([0.915, 0.925, 0.935, 0.945]);
  const D83 = pct([0.815, 0.825, 0.835, 0.845]);
  let mu = 0;
  for (let s = 0; s < S; s++) mu += Math.pow(D[s], LN) * (Cs[s] / totalC);
  mu = Math.pow(mu, 1 / LN);

  const lnCount = legal.filter((n) => n.t >= 0).length;
  const Nstar = legal.length + 0.5 * lnCount;
  const base = 0.97 * Math.pow(0.25 * 0.88 * D93 + 0.2 * 0.94 * D83 + 0.55 * mu, P0) * (Nstar / (Nstar + 60));
  const stars = Q(base);

  const curve = new Float32Array(Math.ceil(S / step));
  for (let i = 0; i < curve.length; i++) curve[i] = 0.97 * D[Math.min(S - 1, i * step)];
  return { stars, curve, step, start: t0 * rate, extrapolated: K > 10 };
}

/** The paper's final scaling. */
function Q(x: number): number {
  if (x < 9) return x;
  if (x < 10.2) return 9 + (5 / 6) * (x - 9);
  if (x < 11.5) return 10 + (10 / 13) * (x - 10.2);
  return 11 + (2 / 3) * (x - 11.5);
}
