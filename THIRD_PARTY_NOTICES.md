# Third-party notices

## Columnist / osu-patterns (Apache License 2.0)

`src/analysis/chartStats.ts` is a TypeScript re-implementation (port) of the chart
statistics and the hand-written rules for osu! user tags, tournament slots and categories
from **Columnist / osu-patterns** by Kominaru — https://github.com/Kominaru/columnist
(files `osu_patterns/mania.py`, `mania_tags.py`, `slots.py`, `categories.py`).

Copyright (c) Kominaru. Licensed under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0). Changes: ported from Python/numpy to
TypeScript, generalised to any key count, subset of the statistics, learned heads not included.
Columnist's model weights and labels are CC BY 4.0 and are not included here.

## MuG Diffusion (code MIT, weights non-commercial) — external tool, not bundled

`maniamap mug`, `automap --engine mug` and the Generate screen's MuG engine run **MuG Diffusion** by
Keytoyze and contributors (https://github.com/Keytoyze/Mug-Diffusion, MIT licence for the code).
It is installed separately by `scripts/setup-mug-diffusion.sh`, which clones the repository and
downloads the model weights from the official bundle; no code or weights are included in maniamap.
The **model weights and the charts they create are non-commercial** (MuG Diffusion README,
"Credits"); generated charts keep the `AIMode: MuG Diffusion vX` line, as the authors ask.
`scripts/mug/mug_generate.py` reproduces the generation steps of MuG Diffusion's `webui.py`
(MIT) without its web UI.

## Mapperatorinator (MIT) — external tool, not bundled

`maniamap ai` and the editor's AI engine run **Mapperatorinator** by OliBomby
(https://github.com/OliBomby/Mapperatorinator, MIT licence; model weights
https://huggingface.co/OliBomby/Mapperatorinator-v32, MIT). It is installed separately by
`scripts/setup-mapperatorinator.sh` and called as a separate program; no code or weights
are included in maniamap. The style-tag list in `src/ai/descriptors.ts` was read from the
model's tokenizer.

## Star Rating Rebirth — algorithm, no code copied

`src/analysis/difficulty.ts` implements the difficulty algorithm described in
"Star Rating Rebirth: A VSRG Difficulty-Rating Framework (Feb 2025 Update)" by [Crz]sunnyxxy
(https://github.com/sunnyxxy/Star-Rating-Rebirth). It was written from the paper; the
reference program was only run to compare results. The rule for 11K–18K cross-column weights
and the Rebirth → osu! star estimate are maniamap's own.

## project-riz/osu-beatmaps — dataset, not bundled

`maniamap data-fetch` downloads from https://huggingface.co/datasets/project-riz/osu-beatmaps.
No data is included in maniamap. The beatmaps and audio belong to their mappers and artists and
are covered by the osu! Terms of Service (https://osu.ppy.sh/legal/Terms); use them for personal
research only and do not redistribute them.

## Research sources (no code copied)

The pattern vocabulary and detection rules in `src/analysis/patterns.ts` were written
after reading, but do not copy code from:

- osu! wiki — Beatmap/Pattern/osu!mania and Beatmap tags (https://github.com/ppy/osu-wiki, CC BY-NC 4.0 text)
- Etterna MinaCalc pattern mods (https://github.com/etternagame/etterna)
- Interlude / YAVSRG pattern finder (https://github.com/YAVSRG/YAVSRG, MIT)
- ManiaMapAnalyser (https://github.com/LeoBlackMT/osumania_map_analyser, MIT)
- krrcream-Toolkit (https://github.com/krrcream/krrcream-Toolkit): the idea of an "any keys"
  converter and an LN transformer with short/long ratio settings; maniamap's converters are
  a separate design (order-keeping mappings, dirt metrics)
