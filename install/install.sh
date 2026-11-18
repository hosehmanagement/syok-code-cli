#!/bin/sh
# Syok Code installer for Mac and Linux.
#   curl -fsSL https://syok-ai.com/syok-code/install.sh | sh
# Puts everything in ~/.syok (nothing else is touched except one PATH line in your shell profile).
# It brings its own private copy of the Bun runtime, so you do not need to install anything first.
# Run it again any time to update. Remove with: rm -rf ~/.syok/bin ~/.syok/syok.js
set -eu

BUN_VERSION="${SYOK_BUN_VERSION:-1.4.4}"
SITE="${SYOK_SITE:-https://syok-ai.com/syok-code}"
BUN_BASE="${SYOK_BUN_BASE:-https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION}"
DIR="${SYOK_HOME:-$HOME/.syok}"
BIN="$DIR/bin"

say() { printf '%s\n' "$*"; }
fail() { printf 'Syok Code install failed: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "the '$1' command is needed. Install it and run this again."; }
need curl; need uname
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else fail "no sha256sum or shasum command to check the download"; fi; }
# Downloads are https only. (http is accepted only from this same computer, which the automatic tests use.)
get() {
  case "$1" in
    http://127.0.0.1:*|http://localhost:*) curl -fsSL --retry 3 -o "$2" "$1" || fail "could not download $1" ;;
    *) curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$2" "$1" || fail "could not download $1" ;;
  esac
}

os=$(uname -s); arch=$(uname -m)
case "$os" in Linux) os=linux ;; Darwin) os=darwin ;; *) fail "this installer is for Mac and Linux. On Windows use PowerShell: irm $SITE/install.ps1 | iex" ;; esac
case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=aarch64 ;; *) fail "unsupported processor: $arch" ;; esac
# A Mac running an Intel program on Apple Silicon should still get the Apple Silicon build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=aarch64; fi
target="bun-$os-$arch"
if [ "$os" = linux ]; then
  # Alpine and other musl systems need the musl build.
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then target="$target-musl"; fi
fi
# Older Intel/AMD processors without AVX2 need the "baseline" build.
if [ "$arch" = x64 ]; then
  if [ "$os" = linux ] && ! grep -qw avx2 /proc/cpuinfo 2>/dev/null; then target="$target-baseline"; fi
  if [ "$os" = darwin ] && ! sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qw AVX2; then target="$target-baseline"; fi
fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t syok)
trap 'rm -rf "$tmp"' EXIT INT TERM
mkdir -p "$BIN"

# 1. The runtime (skipped when the right version is already there).
have=""; [ -x "$BIN/bun" ] && have=$("$BIN/bun" --version 2>/dev/null || true)
if [ "$have" != "$BUN_VERSION" ]; then
  say "Downloading the runtime ($target $BUN_VERSION)..."
  get "$BUN_BASE/$target.zip" "$tmp/bun.zip"
  get "$BUN_BASE/SHASUMS256.txt" "$tmp/sums.txt"
  want=$(grep " $target.zip\$" "$tmp/sums.txt" | cut -d' ' -f1 | head -n 1)
  [ -n "$want" ] || fail "no checksum is published for $target.zip"
  [ "$(sha "$tmp/bun.zip")" = "$want" ] || fail "the runtime download is damaged (checksum does not match). Try again."
  if command -v unzip >/dev/null 2>&1; then unzip -oq "$tmp/bun.zip" -d "$tmp/x"
  elif command -v python3 >/dev/null 2>&1; then python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$tmp/bun.zip" "$tmp/x"
  elif command -v bsdtar >/dev/null 2>&1; then mkdir -p "$tmp/x" && bsdtar -xf "$tmp/bun.zip" -C "$tmp/x"
  else fail "the 'unzip' command is needed. Install it (for example: apt install unzip) and run this again."; fi
  [ -f "$tmp/x/$target/bun" ] || fail "the runtime download did not contain the program"
  chmod +x "$tmp/x/$target/bun"
  "$tmp/x/$target/bun" --version >/dev/null 2>&1 || fail "the runtime does not start on this computer"
  mv -f "$tmp/x/$target/bun" "$BIN/bun"
fi

# 2. Syok Code itself (one small file), checked against its published checksum.
say "Downloading Syok Code..."
get "$SITE/syok.js" "$tmp/syok.js"
get "$SITE/syok.js.sha256" "$tmp/syok.sum"
want=$(cut -d' ' -f1 "$tmp/syok.sum" | head -n 1)
[ -n "$want" ] && [ "$(sha "$tmp/syok.js")" = "$want" ] || fail "the Syok Code download is damaged (checksum does not match). Try again."
"$BIN/bun" "$tmp/syok.js" --help >/dev/null 2>&1 || fail "the downloaded program does not start"
mv -f "$tmp/syok.js" "$DIR/syok.js"

# 3. The "syok" command.
cat > "$BIN/syok" <<LAUNCH
#!/bin/sh
exec "$BIN/bun" "$DIR/syok.js" "\$@"
LAUNCH
chmod +x "$BIN/syok"

# 4. Make the command findable (one line, only if it is not there yet).
added=""
case ":$PATH:" in *":$BIN:"*) ;; *)
  line="export PATH=\"$BIN:\$PATH\""
  for f in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    case "$f" in */.profile) ;; *) [ -f "$f" ] || continue ;; esac
    grep -qF "$BIN" "$f" 2>/dev/null || { printf '\n# Syok Code\n%s\n' "$line" >> "$f"; added="$added $f"; }
  done ;;
esac

say ""
say "Syok Code is installed: $BIN/syok"
if [ -n "$added" ]; then say "Open a new terminal window (or run: export PATH=\"$BIN:\$PATH\") so the 'syok' command is found."; fi
say "Next: run 'syok setup' (a few questions, asked once), then 'syok' in a project folder. See: syok --help"
