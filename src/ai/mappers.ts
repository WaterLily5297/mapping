/**
 * Reference mappers for the AI: osu!mania mappers that Mapperatorinator's mania model knows
 * (it was trained with a mapper token), with the key counts and star ranges of their
 * ranked/loved maps. Conditioning on such a mapper asks the model for that mapper's style.
 * The catalog is built by scripts/bench/build-mapper-catalog.ts.
 */
import catalog from './mappers.json';

export interface MapperInfo { id: number; name?: string; maps: number; byKeys: Record<string, { n: number; min: number; max: number }> }

export const MAPPERS = catalog as unknown as MapperInfo[];

/** How well a mapper fits a key count and an (osu!) star rating: number of their maps at those
 *  keys, weighted by how close the stars are. */
export function mapperFit(m: MapperInfo, keys: number, stars: number): number {
  const k = m.byKeys[String(keys)];
  if (!k) return 0;
  const dist = stars < k.min ? k.min - stars : stars > k.max ? stars - k.max : 0;
  return k.n * Math.exp(-dist / 0.75);
}

/** The best-fitting named mappers for keys and osu! stars (excluding some ids, e.g. the song's own). */
export function referenceMappers(keys: number, stars: number, exclude: number[] = [], top = 8): MapperInfo[] {
  return MAPPERS.filter((m) => m.name && !exclude.includes(m.id))
    .map((m) => ({ m, s: mapperFit(m, keys, stars) }))
    .filter((x) => x.s > 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, top)
    .map((x) => x.m);
}

export function mapperName(id: number): string {
  return MAPPERS.find((m) => m.id === id)?.name ?? `#${id}`;
}

/** Conditioned on a reference mapper the model maps easier than asked (on held-out songs it
 *  came out ~0.4 stars under the target, ~0.2 without a mapper); raise its difficulty input by
 *  this much (osu! stars) so the star adjustment afterwards has less to change. */
export const MAPPER_DIFFICULTY_BOOST = 0.3;
