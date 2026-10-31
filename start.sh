#!/usr/bin/env sh
# Start LiteForeFlow on macOS / Linux:   ./start.sh      (first time: chmod +x start.sh)
cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"
LOCALNODE="$HERE/runtime/node"

# Node.js + npm usable and new enough?
node_ok() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && node scripts/preflight.cjs >/dev/null 2>&1
}

fetch_to() { # fetch_to URL FILE
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else return 1; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Downloads a private copy of Node.js (v22 LTS line) into ./runtime/node. No sudo, nothing else is changed.
download_node() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) echo "  This system ($(uname -s)) is not supported by the automatic download. Install Node.js from https://nodejs.org"; return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) echo "  Unknown CPU ($(uname -m)). Install Node.js from https://nodejs.org"; return 1 ;;
  esac
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    echo "  This Linux uses musl (for example Alpine); the official download does not run here."
    echo "  Install it with your package manager, for example:  apk add nodejs npm"
    return 1
  fi
  if ! command -v tar >/dev/null 2>&1 || { ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; }; then
    echo "  The download needs 'curl' (or 'wget') and 'tar'. Install them, or install Node.js from https://nodejs.org"
    return 1
  fi
  tmp="$(mktemp -d)" || return 1
  base="https://nodejs.org/dist/latest-v22.x"
  fetch_to "$base/SHASUMS256.txt" "$tmp/sums" || { echo "  Could not reach nodejs.org. Check your internet connection."; rm -rf "$tmp"; return 1; }
  line="$(grep -E "node-v[0-9.]+-$os-$arch\.tar\.gz\$" "$tmp/sums" | head -n 1)"
  [ -n "$line" ] || { echo "  No $os/$arch build found at nodejs.org."; rm -rf "$tmp"; return 1; }
  want="${line%% *}"
  name="${line##* }"
  echo "  Downloading $name (about 30 MB)..."
  fetch_to "$base/$name" "$tmp/$name" || { echo "  The download failed. Check your internet connection."; rm -rf "$tmp"; return 1; }
  [ "$(sha256_of "$tmp/$name")" = "$want" ] || { echo "  The download is damaged (checksum does not match). Please try again."; rm -rf "$tmp"; return 1; }
  echo "  Unpacking..."
  rm -rf "$LOCALNODE"
  mkdir -p "$LOCALNODE" || { rm -rf "$tmp"; return 1; }
  tar -xzf "$tmp/$name" -C "$LOCALNODE" --strip-components=1 || { rm -rf "$tmp" "$LOCALNODE"; return 1; }
  rm -rf "$tmp"
  echo "  Node.js is ready."
}

# ---- 1. Node.js: the one on this computer, else our private copy, else offer to download it ----
if ! node_ok && [ -x "$LOCALNODE/bin/node" ]; then
  PATH="$LOCALNODE/bin:$PATH"
  export PATH
fi
if ! node_ok; then
  echo ""
  echo "  LiteForeFlow needs Node.js (the free engine it runs on). It is missing or too old on this computer."
  echo ""
  echo "  It can download its own private copy (about 30 MB, one time) into the 'runtime' folder here."
  echo "  No sudo, and nothing else on your computer is changed."
  echo ""
  answer=y
  if [ -t 0 ]; then
    printf "  Download it now? [Y/n] "
    read -r answer
  fi
  case "$answer" in
    n|N|no|NO) echo ""; echo "  OK. Install the LTS version from https://nodejs.org, then run ./start.sh again."; echo ""; exit 1 ;;
  esac
  echo ""
  download_node || exit 1
  PATH="$LOCALNODE/bin:$PATH"
  export PATH
  node_ok || { echo ""; echo "  The downloaded Node.js does not work on this computer. Install the LTS from https://nodejs.org instead."; exit 1; }
fi

# ---- 2. LiteForeFlow's own packages: installed the first time, repaired when something is missing ----
if ! node scripts/preflight.cjs --deps; then
  echo ""
  echo "  First start: installing LiteForeFlow (about a minute, needs internet, only once)..."
  echo ""
  npm install --no-audit --no-fund --loglevel=error || {
    echo ""
    echo "  The install did not finish. Check your internet connection and run ./start.sh again."
    exit 1
  }
fi

# ---- 3. Start ----
LITEFOREFLOW_OPEN="${LITEFOREFLOW_OPEN:-1}" exec node --max-semi-space-size=2 --max-old-space-size=192 server/src/index.js
