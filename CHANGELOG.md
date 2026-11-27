# Changelog

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
