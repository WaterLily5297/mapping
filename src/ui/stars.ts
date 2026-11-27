/** Star rating colours and names, following osu!'s difficulty spectrum. */

const STOPS: [number, [number, number, number]][] = [
  [0.1, [0x42, 0x90, 0xfb]], [1.25, [0x4f, 0xc0, 0xff]], [2.0, [0x4f, 0xff, 0xd5]], [2.5, [0x7c, 0xff, 0x4f]],
  [3.3, [0xf6, 0xf0, 0x5c]], [4.2, [0xff, 0x80, 0x68]], [4.9, [0xff, 0x4e, 0x6f]], [5.8, [0xc6, 0x45, 0xb8]],
  [6.7, [0x65, 0x63, 0xde]], [7.7, [0x18, 0x15, 0x8e]], [9.0, [0x00, 0x00, 0x00]],
];

/** colour of a star rating (gamma-correct interpolation between the stops) */
export function starColor(stars: number): string {
  if (stars < 0.1) return '#aaaaaa';
  if (stars >= 9) return '#000000';
  let i = 0;
  while (i < STOPS.length - 2 && stars > STOPS[i + 1][0]) i++;
  const [s0, c0] = STOPS[i], [s1, c1] = STOPS[i + 1];
  const t = Math.max(0, Math.min(1, (stars - s0) / (s1 - s0)));
  const g = 2.2;
  const mix = (a: number, b: number) => Math.round(255 * Math.pow((1 - t) * Math.pow(a / 255, g) + t * Math.pow(b / 255, g), 1 / g));
  return `rgb(${mix(c0[0], c1[0])}, ${mix(c0[1], c1[1])}, ${mix(c0[2], c1[2])})`;
}

/** text colour that reads on top of starColor */
export function starTextColor(stars: number): string {
  return stars >= 6.5 ? '#f6f05c' : 'rgba(0, 0, 0, 0.75)';
}

/** the usual difficulty names for a star rating */
export function tierName(stars: number): string {
  if (stars < 2) return 'Easy';
  if (stars < 2.7) return 'Normal';
  if (stars < 4) return 'Hard';
  if (stars < 5.3) return 'Insane';
  if (stars < 6.5) return 'Expert';
  return 'Expert+';
}

/** CSS gradient of the spectrum from `lo` to `hi` stars (for slider tracks) */
export function starGradient(lo: number, hi: number): string {
  const steps = 24;
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = lo + ((hi - lo) * i) / steps;
    parts.push(`${starColor(s)} ${((i / steps) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}
