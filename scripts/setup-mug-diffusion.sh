#!/usr/bin/env bash
# Install MuG Diffusion (https://github.com/Keytoyze/Mug-Diffusion) as a maniamap engine (osu!mania 4K).
#
#   scripts/setup-mug-diffusion.sh                  install or update
#   scripts/setup-mug-diffusion.sh --cpu            force CPU-only PyTorch
#   scripts/setup-mug-diffusion.sh --zip FILE.zip   take the weights from an already downloaded bundle
#   MUG_DIFFUSION_DIR=/path scripts/...             install somewhere else (maniamap reads the same variable)
#
# Licence: the code is MIT; the model weights and the charts they create are NON-COMMERCIAL
# (see the MuG Diffusion README). Charts are tagged "AIMode: MuG Diffusion".
# Needs: git, ffmpeg (uv is downloaded if missing). Disk: ~1 GB of Python packages (CPU) + 1.8 GB weights.
# The weights are fetched from the official 4.4 GB bundle on Google Drive, but only the two files
# that are needed (HTTP range requests), so the download is ~1.8 GB.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/linux-only.sh"
DIR="${MUG_DIFFUSION_DIR:-$HOME/.local/share/maniamap/MugDiffusion}"
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
FORCE_CPU=0
ZIP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cpu) FORCE_CPU=1 ;;
    --zip) ZIP="$2"; shift ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
  shift
done

need() { command -v "$1" >/dev/null 2>&1; }
need git || { echo "git is missing: sudo apt install git"; exit 1; }
need ffmpeg || echo "note: ffmpeg is missing (needed to read audio): sudo apt install ffmpeg"
# uv: the installed one, or the official standalone binary in maniamap's folder (no root needed)
. "$(dirname "$(readlink -f "$0")")/lib/ensure-uv.sh"
ensure_uv || exit 1

if [ -d "$DIR/.git" ]; then
  echo "==> updating $DIR"
  git -C "$DIR" pull --ff-only || true
else
  echo "==> cloning MuG Diffusion into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 https://github.com/Keytoyze/Mug-Diffusion.git "$DIR"
fi

echo "==> creating a Python 3.10 environment"
uv python install 3.10
[ -x "$DIR/.venv/bin/python" ] || uv venv -p 3.10 "$DIR/.venv"
PY="$DIR/.venv/bin/python"

TORCH_INDEX=()
if [ "$FORCE_CPU" = 1 ] || ! need nvidia-smi; then
  echo "==> no NVIDIA GPU found (or --cpu): installing CPU-only PyTorch"
  TORCH_INDEX=(--index-url https://download.pytorch.org/whl/cpu)
fi
uv pip install --python "$PY" "${TORCH_INDEX[@]}" "torch==2.10.*"

echo "==> installing what generation needs (not the web UI)"
# pytorch-lightning 1.9 keeps the 2023 APIs MuG uses; numpy<2 for its array code
uv pip install --python "$PY" "pytorch-lightning==1.9.5" "setuptools<70" "numpy<2" einops omegaconf pyyaml tqdm librosa \
  soundfile audioread scipy opt_einsum scikit-learn

mkdir -p "$DIR/models/ckpt"
if [ -s "$DIR/models/ckpt/model.ckpt" ] && [ -s "$DIR/models/ckpt/model.yaml" ]; then
  echo "==> weights already present"
else
  echo "==> fetching the weights (model.ckpt ~1.8 GB, model.yaml) from the official bundle"
  if [ -n "$ZIP" ]; then "$PY" "$HERE/mug/fetch_weights.py" "$DIR/models/ckpt" --zip "$ZIP"
  else "$PY" "$HERE/mug/fetch_weights.py" "$DIR/models/ckpt"; fi
fi

echo
echo "Done. Check with:   maniamap mug-status"
echo "Generate (4K):      maniamap mug song.mp3 --stars 4 --style jumpstream"
echo "Licence: MuG Diffusion weights and generated charts are non-commercial."
