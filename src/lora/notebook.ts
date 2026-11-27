/**
 * Free cloud-GPU training without a local GPU: package a dataset for Kaggle or Google Colab
 * together with a ready-to-run notebook, and import the trained LoRA afterwards. Node only.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync, unzipSync } from 'fflate';

function addDir(files: Record<string, Uint8Array>, root: string, dir: string, prefix: string) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) addDir(files, root, p, prefix);
    else files[`${prefix}${relative(root, p).split('\\').join('/')}`] = readFileSync(p);
  }
}

/** Zip a dataset made by lora-dataset (metadata.parquet, manifest.json, data/). */
export function zipDataset(datasetDir: string, outZip: string): number {
  if (!existsSync(join(datasetDir, 'metadata.parquet'))) throw new Error(`${datasetDir} has no metadata.parquet (run lora-dataset first)`);
  const files: Record<string, Uint8Array> = {};
  addDir(files, datasetDir, datasetDir, 'maniamap-dataset/');
  const zip = zipSync(files, { level: 0 }); // audio is already compressed
  writeFileSync(outZip, zip);
  return zip.length;
}

export interface NotebookOptions {
  name: string;
  trainScript: string; // contents of scripts/lora/train_lora.py
  steps?: number;
  batch?: number;
  gradAcc?: number;
  rank?: number;
}

const md = (src: string) => ({ cell_type: 'markdown', metadata: {}, source: src.split(/(?<=\n)/) });
const code = (src: string) => ({ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: src.split(/(?<=\n)/) });

/** A notebook that trains the LoRA on a free Kaggle / Colab GPU. Plain Python (no ! magics). */
export function makeNotebook(o: NotebookOptions): string {
  const cells = [
    md(`# maniamap — train the "${o.name}" osu!mania LoRA on a free GPU

**Kaggle** (about 30 free GPU hours a week): New Notebook → *File → Import Notebook* (this file) → *Settings*: Accelerator **GPU T4 x2** or **P100**, Internet **on** → *Add Input → Upload* \`${o.name}-dataset.zip\` → *Run All*. The result appears under *Output* as \`${o.name}-lora.zip\`.

**Google Colab**: *File → Upload notebook* (this file) → *Runtime → Change runtime type → T4 GPU* → *Run all*; upload \`${o.name}-dataset.zip\` when asked. The LoRA zip downloads at the end.

Then on your computer: \`maniamap lora-import ${o.name}-lora.zip --name ${o.name}\`.

Training uses [Mapperatorinator](https://github.com/OliBomby/Mapperatorinator) (OliBomby, MIT). Only train on maps you have the right to use.
`),
    code(`# settings (lower BATCH and raise GRAD_ACC if the GPU runs out of memory)
NAME = ${JSON.stringify(o.name)}
STEPS = ${o.steps ?? 300}
BATCH = ${o.batch ?? 2}
GRAD_ACC = ${o.gradAcc ?? 16}
RANK = ${o.rank ?? 64}
SAVE_EVERY = 25
`),
    code(`# 1. find the dataset (Kaggle input, Colab upload, or a local test)
import os, glob, subprocess, sys, zipfile, shutil
from pathlib import Path

WORK = Path("/kaggle/working") if Path("/kaggle/working").exists() else Path.cwd()
DS = Path(os.environ.get("MANIAMAP_NB_DATASET", ""))
if not (DS / "metadata.parquet").exists():
    found = [Path(p).parent for p in glob.glob("/kaggle/input/**/metadata.parquet", recursive=True)]
    if found:
        DS = found[0]
    else:
        zips = glob.glob("/kaggle/input/**/*-dataset.zip", recursive=True) + glob.glob(str(WORK / "*-dataset.zip"))
        if not zips:
            try:
                from google.colab import files  # Colab: ask for the zip
                zips = [str(WORK / n) for n in files.upload().keys()]
            except ImportError:
                sys.exit("dataset zip not found: upload " + NAME + "-dataset.zip")
        with zipfile.ZipFile(zips[0]) as z:
            z.extractall(WORK / "dataset")
        DS = next((WORK / "dataset").glob("**/metadata.parquet")).parent
print("dataset:", DS)
`),
    code(`# 2. install Mapperatorinator (skipped when MANIAMAP_NB_MAI points to an existing install)
MAI = Path(os.environ.get("MANIAMAP_NB_MAI", WORK / "Mapperatorinator"))
if not (MAI / "inference.py").exists():
    subprocess.run(["git", "clone", "--depth", "1", "https://github.com/OliBomby/Mapperatorinator.git", str(MAI)], check=True)
if not os.environ.get("MANIAMAP_NB_MAI"):
    req = [l for l in (MAI / "requirements.txt").read_text().splitlines() if not l.startswith(("pywebview", "pyqtwebengine"))]
    (WORK / "req.txt").write_text("\\n".join(req))
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "torch==2.10.*", "torchaudio==2.10.*", "-r", str(WORK / "req.txt")], check=True)
`),
    code(`# 3. maniamap's LoRA trainer (mania settings, style tags, checkpoints, fp16 on T4/P100)
TRAIN = WORK / "train_lora.py"
TRAIN.write_text(${JSON.stringify(o.trainScript)})
`),
    code(`# 4. train (checkpoints every SAVE_EVERY steps; if the session stops, re-run this cell with "--resume" added)
device = os.environ.get("MANIAMAP_NB_DEVICE", "gpu")
OUT = WORK / (NAME + "-lora")
cmd = [sys.executable, str(TRAIN), "--mai-dir", str(MAI), "--dataset", str(DS), "--out", str(OUT),
       "--steps", str(STEPS), "--batch", str(BATCH), "--grad-acc", str(GRAD_ACC), "--rank", str(RANK),
       "--save-every", str(SAVE_EVERY), "--device", device, "--work", str(WORK / "lora-work")]
subprocess.run(cmd, check=True, cwd=str(MAI), env={**os.environ, "WANDB_MODE": "disabled"})
`),
    code(`# 5. package the LoRA for download
archive = shutil.make_archive(str(WORK / (NAME + "-lora")), "zip", OUT)
print("LoRA ready:", archive)
try:
    from google.colab import files
    files.download(archive)
except ImportError:
    pass  # Kaggle: download it from the Output tab
`),
  ];
  return JSON.stringify({
    cells,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
      accelerator: 'GPU',
    },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 1);
}

/** Install a LoRA from a zip (downloaded from Kaggle/Colab) or a folder into the store. */
export function importLora(src: string, storeDir: string, name: string): string {
  if (!/^[\w.-]+$/.test(name)) throw new Error('--name: letters, digits, . _ - only');
  const dest = join(storeDir, name);
  const files: Record<string, Uint8Array> = {};
  if (statSync(src).isDirectory()) addDir(files, src, src, '');
  else for (const [n, d] of Object.entries(unzipSync(readFileSync(src)))) if (!n.endsWith('/')) files[n] = d;
  // the adapter may sit in a sub-folder of the zip
  const cfg = Object.keys(files).find((n) => n.split('/').pop() === 'adapter_config.json');
  if (!cfg) throw new Error('no adapter_config.json found: is this a LoRA from lora-train or the maniamap notebook?');
  const base = cfg.slice(0, cfg.length - 'adapter_config.json'.length);
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  for (const [n, d] of Object.entries(files)) {
    if (!n.startsWith(base) || n.includes('..')) continue;
    const p = join(dest, n.slice(base.length));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, d);
  }
  return dest;
}
