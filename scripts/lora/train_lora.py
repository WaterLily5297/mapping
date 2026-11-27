"""Train a Mapperatorinator osu!mania LoRA on a dataset made by `maniamap lora-dataset`.

Run with Mapperatorinator's Python (maniamap's `lora-train` command does this for you):
    python train_lora.py --mai-dir DIR --dataset DATASET --out LORA_DIR
                         [--steps 300] [--batch 4] [--grad-acc 8] [--lr 4e-4] [--rank 64]
                         [--device gpu|cpu] [--precision auto|bf16|fp16|no] [--compile]
                         [--save-every 25] [--resume] [--work WORK_DIR]

What it adds on top of Mapperatorinator's own `osuT5/train.py -cn lora_v32`:
  * mania settings (gamemode 3 weights, gamemode filter, LoRA metadata for the gamemode=3 subfolder)
  * hardware-safe defaults: fp16 on GPUs without bf16 (Colab/Kaggle T4, P100), no FlashAttention
    unless installed, no torch.compile unless asked, no mixed precision on CPU
  * checkpoints every --save-every steps, --resume to continue an interrupted run, and the newest
    LoRA is exported to LORA_DIR even when training is stopped early (Ctrl+C)
  * the style tags (OmdbTags) from maniamap's pattern classifier are registered in the pretrained
    tokenizer for your beatmap IDs, so the LoRA learns which patterns go with which tag
"""
import argparse
import importlib.util
import json
import os
import runpy
import shutil
import sys
from pathlib import Path


def q(v) -> str:
    """Hydra quoted string."""
    return "'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'"


def latest_checkpoint(work: Path):
    cps = [c for c in (work / "checkpoints").glob("checkpoint_*") if c.is_dir()]
    return max(cps, key=lambda c: int(c.name.split("_")[1])) if cps else None


def export_lora(work: Path, out: Path, info: dict, partial: bool) -> bool:
    cp = latest_checkpoint(work)
    if cp is None or not (cp / "lora" / "adapter_config.json").exists():
        return False
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(cp / "lora", out)
    info = {**info, "checkpoint": cp.name, "partial": partial}
    (out / "maniamap.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    print(f"[maniamap] LoRA {'(partial) ' if partial else ''}saved to {out}")
    return True


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--mai-dir", required=True)
    p.add_argument("--dataset", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--work", default=None)
    p.add_argument("--steps", type=int, default=300)
    p.add_argument("--batch", type=int, default=4)
    p.add_argument("--grad-acc", type=int, default=8)
    p.add_argument("--lr", type=float, default=4e-4)
    p.add_argument("--rank", type=int, default=64)
    p.add_argument("--device", choices=["gpu", "cpu"], default="gpu")
    p.add_argument("--precision", choices=["auto", "bf16", "fp16", "no"], default="auto")
    p.add_argument("--compile", action="store_true", help="torch.compile (faster on modern GPUs, slow start)")
    p.add_argument("--save-every", type=int, default=25)
    p.add_argument("--resume", action="store_true", help="continue from the newest checkpoint in the work folder")
    p.add_argument("--workers", type=int, default=None)
    a = p.parse_args()

    mai = Path(a.mai_dir).resolve()
    dataset = Path(a.dataset).resolve()
    out = Path(a.out).resolve()
    work = Path(a.work).resolve() if a.work else out.parent / f".{out.name}-work"
    if not a.resume and work.exists():
        shutil.rmtree(work)  # a fresh run must not mix with an old one
    work.mkdir(parents=True, exist_ok=True)

    import pandas as pd
    import torch
    meta = pd.read_parquet(dataset / "metadata.parquet")
    n_sets = int(meta["BeatmapSetId"].nunique())
    tags_by_id = {int(r.Id): list(r.OmdbTags) for r in meta.itertuples()}

    cpu = a.device == "cpu"
    if not cpu and not torch.cuda.is_available():
        sys.exit("No CUDA GPU found. Use --device cpu (slow) or train on a free cloud GPU: maniamap lora-notebook")
    precision = a.precision
    if precision == "auto":
        precision = "no" if cpu else ("bf16" if torch.cuda.is_bf16_supported() else "fp16")
    attn = "flash_attention_2" if not cpu and importlib.util.find_spec("flash_attn") else "sdpa"
    save_every = max(1, min(a.save_every, a.steps))

    overrides = [
        "--config-name=lora_v32",
        "pretrained_gamemode=3",
        f"device={a.device}",
        f"compile={'true' if a.compile and not cpu else 'false'}",
        f"mixed_precision={precision}",
        f"attn_implementation={attn}",
        "data.dataset_type=mmrs",
        f"data.train_dataset_path={q(dataset)}",
        f"data.test_dataset_path={q(dataset)}",
        "data.train_dataset_start=0",
        f"data.train_dataset_end={n_sets}",
        "data.test_dataset_start=0",
        "data.test_dataset_end=0",
        "data.gamemodes=[3]",
        f"optim.total_steps={a.steps}",
        # Mapperatorinator's optim.batch_size is the batch per optimizer step (it trains micro-batches
        # of batch_size // grad_acc); maniamap's --batch is the micro-batch, so pass the product
        f"optim.batch_size={a.batch * a.grad_acc}",
        f"optim.grad_acc={a.grad_acc}",
        f"optim.base_lr={a.lr}",
        f"lora.r={a.rank}",
        f"lora.lora_alpha={a.rank * 2}",
        "lora_metadata.ckpt_subfolders=['gamemode=3']",
        f"checkpoint.every_steps={save_every}",
        "checkpoint.local_total_limit=1",
        "logging.log_with=wandb",  # Mapperatorinator expects the wandb tracker ...
        "logging.mode=disabled",   # ... but nothing is sent anywhere
        "logging.every_steps=5",
        f"dataloader.num_workers={a.workers if a.workers is not None else (1 if cpu else 2)}",
        f"hydra.run.dir={q(work)}",
    ]
    if cpu:
        overrides.append("dataloader.pin_memory=false")
    if a.resume:
        cp = latest_checkpoint(work)
        if cp is None:
            sys.exit(f"--resume: no checkpoint in {work / 'checkpoints'}")
        overrides.append(f"checkpoint_path={q(cp)}")
        print(f"[maniamap] resuming from {cp.name}")

    os.environ.setdefault("WANDB_MODE", "disabled")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    # same import path as `python osuT5/train.py`: the script's folder first, so `osuT5` is the inner package
    sys.path.insert(0, str(mai / "osuT5"))

    # Register maniamap's style tags for our beatmap IDs in the pretrained tokenizer.
    import osuT5.utils as utils  # noqa: E402  (module that train.py imports load_model from)

    original_load_model = utils.load_model

    def load_model_with_tags(*args, **kwargs):
        model, tokenizer = original_load_model(*args, **kwargs)
        idx = {k.strip(): v for k, v in tokenizer.descriptor_idx.items()}
        added = 0
        for beatmap_id, tags in tags_by_id.items():
            ids = [idx[t] for t in tags if t in idx]
            if ids:
                tokenizer.beatmap_descriptors[beatmap_id] = ids
                added += 1
        print(f"[maniamap] style tags registered for {added}/{len(tags_by_id)} beatmaps")
        return model, tokenizer

    utils.load_model = load_model_with_tags

    info = {
        "dataset": str(dataset), "beatmaps": len(tags_by_id), "sets": n_sets, "steps": a.steps,
        "batch": a.batch, "grad_acc": a.grad_acc, "lr": a.lr, "rank": a.rank, "device": a.device,
        "precision": precision, "keys": sorted({int(k) for k in meta["Keys"]}),
        "tags": sorted({t for ts in tags_by_id.values() for t in ts}),
    }
    sys.argv = [str(mai / "osuT5" / "train.py"), *overrides]
    print("[maniamap] training:", " ".join(overrides[1:]))
    print(f"[maniamap] checkpoints every {save_every} steps in {work}; stop with Ctrl+C and continue later with --resume")
    try:
        runpy.run_path(str(mai / "osuT5" / "train.py"), run_name="__main__")
    except KeyboardInterrupt:
        print("\n[maniamap] stopped")
        if not export_lora(work, out, info, partial=True):
            print("[maniamap] no checkpoint yet, nothing to export")
        sys.exit(130)
    except SystemExit as e:  # hydra exits after main(); treat 0/None as success
        if e.code not in (0, None):
            export_lora(work, out, info, partial=True)
            raise

    if not export_lora(work, out, info, partial=False):
        sys.exit(f"training finished but no LoRA checkpoint was found in {work / 'checkpoints'}")


if __name__ == "__main__":
    main()
