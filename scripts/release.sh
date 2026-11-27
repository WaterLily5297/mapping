#!/usr/bin/env bash
# Build the release package: a prebuilt maniamap that needs only Node.js 20+ to install.
#   scripts/release.sh            -> release/maniamap-<version>-linux.tar.gz (+ .sha256)
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/linux-only.sh"
cd "$(dirname "$(readlink -f "$0")")/.."
VERSION="$(node -p 'require("./package.json").version')"
NAME="maniamap-$VERSION"
OUT="release/$NAME"
echo "==> building maniamap $VERSION"
npm run build --silent
rm -rf "$OUT" "release/$NAME-linux.tar.gz"
mkdir -p "$OUT/scripts"
cp -r dist assets install.sh LICENSE THIRD_PARTY_NOTICES.md README.md CHANGELOG.md package.json "$OUT/"
# runtime scripts only (engine setup, LoRA training, MuG runner); not the benchmarks or tests
cp -r scripts/lib scripts/lora scripts/mug scripts/setup-mapperatorinator.sh scripts/setup-mug-diffusion.sh "$OUT/scripts/"
find "$OUT" -name '__pycache__' -prune -exec rm -rf {} +
tar -C release -czf "release/$NAME-linux.tar.gz" "$NAME"
( cd release && sha256sum "$NAME-linux.tar.gz" > "$NAME-linux.tar.gz.sha256" )
rm -rf "$OUT"
echo "==> release/$NAME-linux.tar.gz ($(du -h "release/$NAME-linux.tar.gz" | cut -f1))"
