/**
 * Catalog of osu!mania mappers that Mapperatorinator's mania model knows (mapper tokens), with
 * the key counts and star ranges of their ranked/loved maps. Used to condition the AI on the
 * style of mappers with high-quality maps at the requested keys and stars ("reference mapper").
 *
 *   npx tsx scripts/bench/build-mapper-catalog.ts TOKENIZER_JSON DATA_DIR [DATA_DIR...]
 *
 * TOKENIZER_JSON: <hf cache>/models--OliBomby--Mapperatorinator-v32/snapshots/<rev>/gamemode=3/tokenizer.json
 * DATA_DIR: folders written by `maniamap data-fetch` (maniamap-source.json per song).
 * Writes src/ai/mappers.json.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [tokPath, ...dirs] = process.argv.slice(2);
const tok = JSON.parse(readFileSync(tokPath, 'utf8')) as { mapper_idx: Record<string, number>; beatmap_mapper: Record<string, number> };
const known = new Set(Object.keys(tok.mapper_idx));

interface Entry { id: number; name?: string; maps: number; byKeys: Record<string, { n: number; min: number; max: number }> }
const cat = new Map<number, Entry>();
const seen = new Set<number>();
for (const dir of dirs) {
  for (const set of readdirSync(dir)) {
    const p = join(dir, set, 'maniamap-source.json');
    if (!existsSync(p)) continue;
    const src = JSON.parse(readFileSync(p, 'utf8'));
    for (const b of src.beatmaps ?? []) {
      if (seen.has(b.beatmap_id)) continue;
      seen.add(b.beatmap_id);
      if (![1, 2, 4].includes(b.approved)) continue; // ranked, approved, loved
      const mapper = Number(tok.beatmap_mapper[String(b.beatmap_id)] ?? b.creator_id);
      if (!known.has(String(mapper)) || !b.keys || !b.difficultyrating) continue;
      const e = cat.get(mapper) ?? { id: mapper, maps: 0, byKeys: {} };
      if (mapper === b.creator_id && b.creator) e.name = b.creator;
      e.maps++;
      const k = (e.byKeys[b.keys] ??= { n: 0, min: 99, max: 0 });
      k.n++;
      k.min = Math.min(k.min, +b.difficultyrating.toFixed(2));
      k.max = Math.max(k.max, +b.difficultyrating.toFixed(2));
      cat.set(mapper, e);
    }
  }
}
const list = [...cat.values()].sort((a, b) => b.maps - a.maps);
writeFileSync(new URL('../../src/ai/mappers.json', import.meta.url), JSON.stringify(list));
console.log(`${list.length} mappers known to the model, from ${seen.size} beatmaps; named: ${list.filter((m) => m.name).length}`);
console.log(list.slice(0, 15).map((m) => `${m.name ?? '#' + m.id} (${m.maps}: ${Object.entries(m.byKeys).map(([k, v]) => `${k}K ${v.min}-${v.max}*`).join(', ')})`).join('\n'));
