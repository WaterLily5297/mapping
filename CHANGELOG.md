# Changelog

## 1.3.0 — 2026-11-28

### Generate
- **4K pattern choice retrained** on about 3,000 ranked songs: auto style picks streams, jumpstream and chordjack closer to the ranked maps. Measured at the app's defaults on held-out songs: pattern-mix distance 0.447 → 0.432 around 5★ and 0.555 → 0.497 around 7★, where rhythm match also rose (0.706 → 0.725). 6K and 7K keep their previous model, which the retrained one did not beat.

### Benchmarks
- The generator benchmark now measures what the app makes by default: auto style (`--style auto`) and the default long-note amount (`--ln 0.25`). With them, the long-note share of generated charts matches ranked rice maps (4K 0.09 vs 0.10, 6K 0.13 vs 0.14, 7K 0.13 vs 0.15).
- Checked and left as they were: the long-note default (0.25), the speed-or-chordjack decision at 6★+ (agrees with the ranked map on 70% of 4K and 92–99% of 7K songs), and 4K speed mode's jack limit.

## 1.2.0 — 2026-11-28

### Generate
- **Rhythm model trained on 3× the data**, with the sounds around each grid tick and a small hidden layer: it picks the ranked map's note positions more often (held-out 0.845 → 0.862 on 781 4K/6K/7K maps). Quick rules charts follow ranked rhythm a little better in every key count (rhythm F1 4K +0.003, 6K +0.010, 7K +0.005; more songs improved than got worse).

## 1.1.0 — 2026-11-27

### Audio
- More precise note timing: sound peaks are located between analysis frames. On 40 held-out ranked songs the timing error went from 3.7 to 2.8 ms.
- **Music energy curve** (the song's intensity / emotion per measure), learned from 451 ranked 4K/6K/7K maps: loudness, onset rate and strength, spectral flux, bass/mid/treble, brightness, noisiness, and the change against the previous and next measures. It follows where ranked maps get dense better than loudness alone: 7K 0.63 → 0.69, 6K 0.63 → 0.66, 4K 0.55 → 0.65, 6+★ 0.70 → 0.75 (held-out correlation).
- 6K and 7K charts follow the energy curve (7K density shape 0.51 → 0.55 against ranked maps, 7K 6+★ 0.61 → 0.65); 4K keeps loudness, where the curve did not help the generated charts.

### Generate
- Quick rules makes several charts and keeps the best one by a quality score (star accuracy, notes on sounds, density following the energy curve, loud measures filled, cleanliness): about half the star error. `--candidates N` (default 3).
- **AI: Best of N** (Generate → Best of, or `maniamap ai --candidates N`): the model runs N times and the chart with the best quality score is kept. The AI's charts differ a lot between seeds, most of all in 4K: on hard held-out 4K songs best of 3 moved the pattern mix much closer to the ranked map (distance 0.46 → 0.33) and improved rhythm (F1 0.933 → 0.948); on hard 7K it cut fast jacks (14.4 → 11.7), on mid 7K it improved rhythm a little (0.912 → 0.920); on hard 6K rhythm and pattern mix improved but the kept charts had more fast jacks (4 test songs). Measured on the delivered charts, after the star adjustment. N times slower, so it is off by default.

## 1.0.0 — 2026-11-26

The first release: an osu!mania map generator and editor for any key count (1K–18K) that runs on your computer.

### Generate
- **AI mapper** (Mapperatorinator V32, the osu!mania model trained on ranked maps) is the default engine, with a reference-mapper style, a model choice (V32 / V32-mini) and optional style add-ons (LoRA). 7K uses plain V32, the setup that matched ranked 6–10★ maps best.
- **Set up the AI from the app**: one button installs it (about 2 GB, no terminal needed); `maniamap setup ai` does the same from a terminal. The Python manager it needs is downloaded automatically if missing.
- **MuG Diffusion** (4K, optional, non-commercial weights) and a **Quick rules** engine for instant drafts.
- **Difficulty first**: pick the stars (Star Rating Rebirth, up to ~11★ osu!) and every engine's result is adjusted to them cleanly; the adjustment keeps the song's loud parts dense and its quiet parts light.
- **Styles** for Quick rules: auto, balanced, stream, jumpstream, chordjack, tech, LN; learned rhythm, style and long-note models trained on ranked maps; contrast that follows the song's loudness; optional sound direction (stereo position → hand).
- Full difficulty spreads, variations and mapset `.osz` export; pattern mix, difficulty graph and a clean check for every result.

### Audio
- Notes are placed where mappers place them: 25 ms earlier than the detected sound peak (measured on ranked maps).
- Learned tempo and beat-phase models: on held-out ranked songs a usable beat grid (right BPM, within 25 ms) went from 13% to 73% of songs; ⅔-tempo errors are gone.
- Tempo changes are detected and become red lines.
- No more empty seconds in AI maps of dense songs (the AI's inference window was re-tuned).

### Edit and tools
- Editor for any key count with live mapping, timing tools, pattern analysis and checks.
- Command-line tools: `automap`, `ai`, `adjust`, `convert` (clean key conversion), `ln`, `rate`, `patterns`, `sr`, `info`, LoRA training (`lora-dataset`, `lora-train`, `lora-notebook`, `lora-import`).

### App
- The AI runs as fast in the app as on the command line: it leaves one CPU core free for the browser (with one core busy, 15 s of audio took 392 s with all threads and 89 s with one left free), and the page stops drawing while a chart is generated (busy: 1.2 cores → 0.2; idle: 0.5 → 0.1). A 45 s clip that took over 27 minutes in the app now takes under 3.
- The AI setup can be stopped and started again (it continues where it stopped); while a large download prints nothing the panel says it is still working, and Cancel asks first.
- A stopped or failed AI setup no longer counts as installed (the setup writes a marker as its last step), and when the AI stops, the message says why in one line and what to do (e.g. a missing package: run the setup again).
- Engine folders are remembered (`~/.config/maniamap/config.json`): an AI installed in a folder of your choice is also found when maniamap starts from the applications menu.
- Desktop entry without a terminal window, with an icon; a second launch reopens the running app; **Quit** in the app bar.
- `maniamap doctor` checks everything and says how to fix what is missing; `maniamap update` updates a git checkout or a release package.
