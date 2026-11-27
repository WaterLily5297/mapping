#!/usr/bin/env bash
# Install Mapperatorinator (https://github.com/OliBomby/Mapperatorinator, MIT) for maniamap's AI mapper.
#
#   scripts/setup-mapperatorinator.sh            install or update
#   scripts/setup-mapperatorinator.sh --cpu      force CPU-only PyTorch (small download, slower generation)
#   MAPPERATORINATOR_DIR=/path scripts/...       install somewhere else (maniamap reads the same variable)
#
# Needs: git and ffmpeg (sudo apt install git ffmpeg). uv (Python manager) is downloaded if missing.
# Disk: about 1 GB (CPU) or 5 GB (NVIDIA CUDA) for Python packages, plus 0.9 GB for the mania model.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/linux-only.sh"
DIR="${MAPPERATORINATOR_DIR:-$HOME/.local/share/maniamap/Mapperatorinator}"
FORCE_CPU=0
[ "${1:-}" = "--cpu" ] && FORCE_CPU=1

need() { command -v "$1" >/dev/null 2>&1; }
need git || { echo "git is missing: sudo apt install git"; exit 1; }
need ffmpeg || echo "note: ffmpeg is missing (needed to read audio): sudo apt install ffmpeg"
# uv: the installed one, or the official standalone binary in maniamap's folder (no root needed)
. "$(dirname "$(readlink -f "$0")")/lib/ensure-uv.sh"
ensure_uv || exit 1

rm -f "$DIR/.maniamap-setup-complete"
if [ -d "$DIR/.git" ]; then
  echo "==> updating $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "==> cloning Mapperatorinator into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 https://github.com/OliBomby/Mapperatorinator.git "$DIR"
fi

echo "==> creating a Python 3.10 environment"
uv python install 3.10
[ -x "$DIR/.venv/bin/python" ] || uv venv -p 3.10 "$DIR/.venv"
PY="$DIR/.venv/bin/python"

TORCH_INDEX=()
if [ "$FORCE_CPU" = 1 ] || ! need nvidia-smi; then
  echo "==> no NVIDIA GPU found (or --cpu): installing CPU-only PyTorch"
  TORCH_INDEX=(--index-url https://download.pytorch.org/whl/cpu)
else
  echo "==> NVIDIA GPU found: installing PyTorch with CUDA"
fi
uv pip install --python "$PY" "${TORCH_INDEX[@]}" "torch==2.10.*" "torchaudio==2.10.*"

echo "==> installing Mapperatorinator's requirements (without its desktop GUI)"
grep -v -E '^(pywebview|pyqtwebengine)' "$DIR/requirements.txt" > "$DIR/.maniamap-requirements.txt"
uv pip install --python "$PY" -r "$DIR/.maniamap-requirements.txt"

echo "==> downloading the osu!mania model (about 0.9 GB)"
"$PY" - <<'PYEOF'
from huggingface_hub import snapshot_download
snapshot_download("OliBomby/Mapperatorinator-v32", allow_patterns=["gamemode=3/*", "*.json"])
PYEOF

# the marker maniamap checks: the setup ran to the end (an environment alone may be a stopped setup)
date -u +%FT%TZ > "$DIR/.maniamap-setup-complete"

echo
echo "Done. Check with:   maniamap ai-status"
echo "Generate with:      maniamap ai song.mp3 --keys 7 --stars 4 --tags style/jumpstream"
[ "$DIR" = "$HOME/.local/share/maniamap/Mapperatorinator" ] || echo "Remember: export MAPPERATORINATOR_DIR=\"$DIR\""
