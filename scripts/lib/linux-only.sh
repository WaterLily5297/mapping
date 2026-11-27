# Sourced by maniamap's shell scripts: supported systems only.
case "$(uname -s)" in
  Linux) ;;
  MINGW*|MSYS*|CYGWIN*|Windows*) echo "maniamap runs on Linux only. Windows is not supported."; exit 1 ;;
  *) echo "maniamap runs on Linux only (found: $(uname -s))."; exit 1 ;;
esac
if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null || [ -n "${WSL_DISTRO_NAME:-}" ]; then
  echo "maniamap runs on Linux only. WSL (Linux under Windows) is not supported."; exit 1
fi
