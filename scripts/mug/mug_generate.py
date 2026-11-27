#!/usr/bin/env python3
"""
Headless MuG Diffusion generation for maniamap (osu!mania 4K).

Runs the same pipeline as MuG Diffusion's web UI (webui.py startMapping): feature prompt ->
audio encoder -> DDIM sampling -> decoder -> .osu, without gradio. Run it with MuG Diffusion's
folder as the working directory (its configs and template are read from there):

    cd $MUG_DIFFUSION_DIR && .venv/bin/python /path/to/mug_generate.py '<json options>'

Options (JSON): audio, out_dir, title, artist, sr (osu! stars), ett (Etterna MSD, optional),
rank_status (ranked|loved|graveyard), map_type (rc|ln|hb|null), ln_ratio (0..1|null),
patterns ({"stream": "more", "chordjack": "less", ...}), count, steps, cfg, seed,
rm_jacks_ms, auto_snap, bpm + offset (known timing: snap to it instead of estimating).
Prints "MUG-OUTPUT <path>" for every .osu written.
"""
import json
import os
import random
import sys

sys.path.insert(0, os.getcwd())  # MuG Diffusion's folder (the working directory) holds the `mug` package

import numpy as np
import torch
import yaml
from omegaconf import OmegaConf

from mug.data.convertor import save_osu_file, parse_osu_file
from mug.data.utils import gridify, remove_intractable_mania_mini_jacks
from mug.diffusion.ddim import DDIMSampler
from mug.util import feature_dict_to_embedding_ids, instantiate_from_config, load_audio_without_cache

PATTERNS = ["chordjack", "stamina", "stream", "jumpstream", "handstream", "jackspeed", "technical"]


def log(*a):
    print(*a, flush=True)


def load_model(config, ckpt):
    # The official Lightning checkpoint also holds training state, so it can only be read as a
    # full pickle. Read it once, keep just the weights next to it, and from then on load those
    # in PyTorch's safe weights-only mode.
    weights = os.path.join(os.path.dirname(ckpt), "model.weights.pt")
    if os.path.exists(weights):
        sd = torch.load(weights, map_location="cpu", weights_only=True)
    else:
        log("first run: reading the official checkpoint and saving a weights-only copy")
        sd = torch.load(ckpt, map_location="cpu", weights_only=False)["state_dict"]
        torch.save(sd, weights + ".part")
        os.replace(weights + ".part", weights)
    model = instantiate_from_config(config.model)
    model.load_state_dict(sd, strict=False)
    model.eval()
    return model


def snap_to(bpm, offset):
    """MuG's own snapping (divisors 1..32, 10 ms tolerance), but on known timing."""
    divs = [1, 2, 4, 3, 6, 8, 16, 32]

    def fmt(t):
        for d in divs:
            gap = 60000 / (bpm * d)
            meter = (t - offset) / gap
            if abs(meter - round(meter)) < 10 / gap:
                return str(int(round(round(meter) * gap + offset)))
        return str(int(t))

    def run(hit_objects):
        out = []
        for line in hit_objects:
            e = line.split(",")
            e[2] = fmt(int(e[2]))
            if int(e[3]) == 128:
                end = e[5].split(":")
                end[0] = fmt(int(end[0]))
                e[5] = ":".join(end)
            out.append(",".join(e))
        return out

    return run


def main():
    o = json.loads(sys.argv[1])
    seed = int(o.get("seed", -1))
    if seed < 0:
        seed = random.randint(1, 100000000)
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    count = int(o.get("count", 1))
    steps = int(o.get("steps", 100))
    cfg = float(o.get("cfg", 5.0))
    log(f"MuG Diffusion: seed {seed}, {count} chart(s), {steps} steps, cfg {cfg}")

    config = OmegaConf.load("models/ckpt/model.yaml")
    model = load_model(config, "models/ckpt/model.ckpt")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = model.to(device)
    sampler = DDIMSampler(model, device)
    log(f"model loaded (MuG Diffusion v{config.version}) on {device}")

    # ---- prompt (same keys as the web UI)
    feature = {}
    if o.get("rank_status"):
        feature["rank_status"] = o["rank_status"]
    if o.get("sr") is not None:
        feature["sr"] = float(o["sr"])
    if o.get("ett") is not None:
        feature["ett"] = float(o["ett"])
    if o.get("map_type") in ("rc", "ln", "hb"):
        feature[o["map_type"]] = 1
    if o.get("ln_ratio") is not None:
        feature["ln_ratio"] = float(o["ln_ratio"])
    for name, how in (o.get("patterns") or {}).items():
        if name in PATTERNS:
            feature[name] = how == "more"
    log("prompt: " + ", ".join(f"{k}={v}" for k, v in feature.items()))
    feature_yaml = yaml.safe_load(open("configs/mug/mania_beatmap_features.yaml"))

    def embed(d):
        f = torch.tensor(np.asarray([feature_dict_to_embedding_ids(d, feature_yaml) for _ in range(count)]),
                         dtype=torch.float32, device=model.device)
        return model.model.cond_stage_model(f)

    with torch.no_grad():
        c = embed(feature)
        uc = embed({}) if cfg != 1.0 else None
        dataset = config.data.params.common_params
        hop = dataset.n_fft // 4
        frame_s = hop / dataset.sr
        audio = load_audio_without_cache(o["audio"], dataset.n_mels, hop, dataset.n_fft, dataset.sr, None)
        t = audio.shape[1]
        ratio = dataset.max_audio_frame // model.z_length
        map_len = (int(t / ratio / 32) + 1) * 32
        dataset.max_audio_frame = map_len * ratio
        model.z_length = map_len
        if t < dataset.max_audio_frame:
            audio = np.concatenate([audio, np.zeros((dataset.n_mels, dataset.max_audio_frame - t), dtype=np.float32)], axis=1)
        else:
            audio = audio[:, :dataset.max_audio_frame]
        w = model.model.wave_model(torch.tensor(np.stack([audio] * count), dtype=torch.float32).to(model.device))
        log(f"audio encoded ({t * frame_s:.0f} s); sampling...")
        samples, _ = sampler.sample(S=steps, c=c, w=w, batch_size=count, shape=None, verbose=False,
                                    unconditional_guidance_scale=cfg, unconditional_conditioning=uc, eta=0.0)
        x = model.model.decode(samples).cpu().numpy()

    params = {"frame_ms": frame_s * dataset.audio_note_window_ratio * 1000,
              "max_frame": dataset.max_audio_frame // dataset.audio_note_window_ratio, "from_logits": True}
    _, meta = parse_osu_file("asset/template.osu", params)
    bpm, offset = o.get("bpm"), o.get("offset")
    rm = int(o.get("rm_jacks_ms", 90))

    def grid(hit_objects):
        if bpm:
            hit_objects = snap_to(float(bpm), float(offset or 0))(hit_objects)
            b, off = float(bpm), float(offset or 0)
        else:
            snapped, b, off = gridify(hit_objects, verbose=False)
            if o.get("auto_snap", True):
                hit_objects = snapped
        hit_objects = remove_intractable_mania_mini_jacks(hit_objects, verbose=False, jack_interval=rm)
        return b, off, hit_objects

    os.makedirs(o["out_dir"], exist_ok=True)
    for i, sample in enumerate(x):
        creator = f"MuG Diffusion v{config.version}"
        path = os.path.join(o["out_dir"], f"mug-{i + 1}.osu")
        save_osu_file(meta, sample, path=path, gridify=grid, override={
            "Creator": creator, "Version": f"AI v{i + 1}", "AudioFilename": os.path.basename(o.get("audio_name") or o["audio"]),
            "Title": o.get("title", "Untitled"), "TitleUnicode": o.get("title", "Untitled"),
            "Artist": o.get("artist", "Unknown"), "ArtistUnicode": o.get("artist", "Unknown"),
            "AIMode": creator, "AIPrompt": ", ".join(f"{k}={v}" for k, v in feature.items()) + f", seed={seed}, {i}",
        })
        log(f"MUG-OUTPUT {path}")


if __name__ == "__main__":
    main()
