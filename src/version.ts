/** maniamap's version (kept equal to package.json by test/product.test.ts) */
export const VERSION = '1.0.0';

/** `newer` is a later version than `older` (x.y.z, an optional leading v) */
export function newerVersion(newer: string, older: string): boolean {
  const p = (v: string) => v.replace(/^v/, '').split('.').map((x) => Number(x) || 0);
  const [a, b] = [p(newer), p(older)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}
