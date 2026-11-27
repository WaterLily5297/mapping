"""Write metadata.parquet for a Mapperatorinator "mmrs" dataset prepared by `maniamap lora-dataset`.

Run with Mapperatorinator's Python (it has pandas, pyarrow and rosu-pp-py):
    python build_metadata.py DATASET_DIR

DATASET_DIR contains manifest.json (written by maniamap) and data/<set folder>/{audio, .osu files}.
"""
import json
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd
import rosu_pp_py as rosu

SPEEDS = (0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0)  # the speeds Mapperatorinator interpolates star ratings over


def main(dataset: Path) -> None:
    manifest = json.loads((dataset / "manifest.json").read_text(encoding="utf-8"))
    rows = []
    for m in manifest["beatmaps"]:
        osu_path = dataset / "data" / m["BeatmapSetFolder"] / m["BeatmapFile"]
        bm = rosu.Beatmap(path=str(osu_path))
        stars = [float(rosu.Difficulty(clock_rate=r).calculate(bm).stars) for r in SPEEDS]
        date = datetime(int(m.get("Year") or 2023), 1, 1)
        rows.append({
            "Id": int(m["Id"]),
            "BeatmapSetId": int(m["BeatmapSetId"]),
            "BeatmapSetFolder": m["BeatmapSetFolder"],
            "BeatmapFile": m["BeatmapFile"],
            "AudioFile": m["AudioFile"],
            "ModeInt": 3,
            "StarRating": stars,
            "DifficultyRating": stars[2],
            "SubmittedDate": date,
            "RankedDate": date,
            "UserId": int(m.get("UserId") or 0),
            "Ranked": int(m.get("Ranked") or 1),
            "OmdbTags": list(m.get("OmdbTags") or []),
            "Keys": int(m["Keys"]),
            "Version": m.get("Version", ""),
            "Creator": m.get("Creator", ""),
        })
        print(f"  {stars[2]:5.2f}*  {m['Keys']}K  {m['BeatmapSetFolder']}/{m['BeatmapFile']}  {', '.join(m.get('OmdbTags') or [])}")
    if not rows:
        sys.exit("no beatmaps in manifest.json")
    df = pd.DataFrame(rows)
    df.to_parquet(dataset / "metadata.parquet")
    sets = df["BeatmapSetId"].nunique()
    print(f"wrote {dataset / 'metadata.parquet'}: {len(df)} beatmaps in {sets} sets")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]).resolve())
