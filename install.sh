#!/usr/bin/env bash
# maniamap installer for Debian / Ubuntu (user install; root is only needed for apt).
#   ./install.sh               build (or use the prebuilt release), add ~/.local/bin/maniamap and an applications-menu entry
#   ./install.sh --uninstall   remove the command and the menu entry
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. scripts/lib/linux-only.sh
BIN="$HOME/.local/bin/maniamap"
DESKTOP="$HOME/.local/share/applications/maniamap.desktop"
ICON="$HOME/.local/share/icons/hicolor/scalable/apps/maniamap.svg"
LOG="$HOME/.local/state/maniamap/app.log"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$BIN" "$DESKTOP" "$ICON"
  echo "Removed $BIN and $DESKTOP. Delete this folder to remove maniamap completely."
  exit 0
fi

need() { command -v "$1" >/dev/null 2>&1; }
if ! need node || ! need npm; then
  echo "Node.js is not installed. On Debian run:  sudo apt install nodejs npm"
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 20 ]; then
  echo "maniamap needs Node.js 20 or newer (found $(node -v)). Debian 13 ships Node 20: sudo apt install nodejs"
  exit 1
fi
if ! need ffmpeg; then
  echo "note: ffmpeg not found. The editor works without it, but the CLI auto-mapper and 'rate' need it:"
  echo "      sudo apt install ffmpeg"
fi

if [ -f dist/cli.mjs ] && [ -f dist/web/index.html ] && [ ! -d src ]; then
  # release package: already built, nothing to download or compile
  echo "==> prebuilt maniamap $(node -p 'require("./package.json").version')"
else
  echo "==> installing dependencies"
  npm ci --no-audit --no-fund
  echo "==> building"
  npm run build
  echo "==> running tests"
  npm test --silent
fi

chmod +x dist/cli.mjs
mkdir -p "$(dirname "$BIN")" "$(dirname "$DESKTOP")" "$(dirname "$ICON")"
ln -sf "$PWD/dist/cli.mjs" "$BIN"
cp assets/maniamap.svg "$ICON"
# no terminal window: the app opens in the browser and has a Quit button; a second launch reopens it
cat > "$DESKTOP" <<DESK
[Desktop Entry]
Type=Application
Name=maniamap
GenericName=osu!mania map generator
Comment=Generate and edit osu!mania maps (1K-18K) with an AI mapper
Exec=$BIN editor --log $LOG
Icon=maniamap
Terminal=false
StartupNotify=false
Categories=AudioVideo;Audio;Game;
Keywords=osu;mania;rhythm;beatmap;mapping;
DESK
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESKTOP")" >/dev/null 2>&1 || true

echo
echo "Installed."
echo "  maniamap                 in your applications menu, or: maniamap editor"
echo "  AI mapper (best maps):   the app offers to set it up, or: maniamap setup ai   (~2 GB)"
echo "  check everything:        maniamap doctor"
echo "  all command-line tools:  maniamap help"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "  note: $HOME/.local/bin is not on your PATH yet; log out and in again, or run: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac
