# Sourced by the setup scripts: make `uv` (Python manager, https://github.com/astral-sh/uv) available.
# Uses an installed uv when there is one; otherwise downloads the official standalone binary from
# uv's GitHub releases into maniamap's own folder (no root, no pipx, nothing else on the system
# changes) and checks it against the published SHA-256.
ensure_uv() {
  if command -v uv >/dev/null 2>&1; then return 0; fi
  local home="${MANIAMAP_HOME:-$HOME/.local/share/maniamap}" bin
  bin="$home/bin"
  if [ -x "$bin/uv" ]; then export PATH="$bin:$PATH"; return 0; fi
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo "uv is missing and there is no ready-made uv for $(uname -m). Install it: https://docs.astral.sh/uv/"; return 1 ;;
  esac
  local name="uv-$arch-unknown-linux-gnu" url tmp
  url="https://github.com/astral-sh/uv/releases/latest/download/$name.tar.gz"
  tmp="$(mktemp -d)"
  echo "==> uv (Python manager) is not installed: downloading it into $bin"
  fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
    else python3 -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' "$1" "$2"; fi
  }
  if ! fetch "$url" "$tmp/uv.tar.gz" || ! fetch "$url.sha256" "$tmp/uv.sha256"; then
    echo "could not download uv. Install it yourself: sudo apt install pipx && pipx install uv"; rm -rf "$tmp"; return 1
  fi
  local want got
  want="$(awk '{print $1}' "$tmp/uv.sha256")"
  got="$(sha256sum "$tmp/uv.tar.gz" | awk '{print $1}')"
  if [ -z "$want" ] || [ "$want" != "$got" ]; then echo "the uv download did not match its checksum; not installing it"; rm -rf "$tmp"; return 1; fi
  mkdir -p "$bin"
  tar -xzf "$tmp/uv.tar.gz" -C "$tmp"
  install -m 755 "$tmp/$name/uv" "$bin/uv"
  [ -f "$tmp/$name/uvx" ] && install -m 755 "$tmp/$name/uvx" "$bin/uvx"
  rm -rf "$tmp"
  export PATH="$bin:$PATH"
  echo "    uv $(uv --version | awk '{print $2}') installed"
}
