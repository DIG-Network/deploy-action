#!/usr/bin/env bash
# Install the headless `digstore` CLI on a CI runner, pinned to a version.
#
# Resolution order (first that works wins):
#   1. A prebuilt CLI binary attached to the pinned GitHub Release
#      (DIG-Network/digstore, asset `digstore-<os>-<arch>[.exe]`). This is the
#      fast path the public one-line installer (roadmap #9) will feed; if the
#      release does not yet carry a headless CLI asset, fall through.
#   2. `cargo install` from the pinned git tag — always works on a runner with a
#      Rust toolchain (the action installs one if missing). Slower but reliable
#      until #9 ships public per-OS CLI tarballs.
#
# Usage: install-digstore.sh <version>      e.g. v0.5.29   (or "latest")
# Honors: RUNNER_OS (Actions sets it), or `uname` as a fallback.
set -euo pipefail

VERSION="${1:-latest}"
REPO="DIG-Network/digstore"
BINDIR="${DIG_BINDIR:-$HOME/.dig-bin}"
mkdir -p "$BINDIR"

log() { printf '• %s\n' "$*" >&2; }

# --- platform detection ------------------------------------------------------
os="${RUNNER_OS:-$(uname -s)}"
case "$os" in
  Linux|linux)   OS=linux;  EXT="" ;;
  macOS|Darwin|darwin) OS=macos; EXT="" ;;
  Windows|*MINGW*|*MSYS*|*CYGWIN*) OS=windows; EXT=".exe" ;;
  *) OS=linux; EXT="" ;;
esac
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) ARCH="$arch" ;;
esac

# Resolve "latest" to a concrete tag so the install is reproducible in logs.
TAG="$VERSION"
if [ "$VERSION" = "latest" ]; then
  if command -v gh >/dev/null 2>&1 && [ -n "${GITHUB_TOKEN:-}" ]; then
    TAG="$(gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null || echo latest)"
  fi
fi
log "digstore target: repo=$REPO tag=$TAG os=$OS arch=$ARCH"

# --- 1. try a prebuilt CLI release asset -------------------------------------
# Conventional headless-CLI asset name the public installer (#9) is expected to
# publish. (The current releases ship GUI installers only; this is a no-op until
# #9 lands, then it becomes the fast path with no code change here.)
ASSET="digstore-${OS}-${ARCH}${EXT}"
DEST="$BINDIR/digstore${EXT}"
try_release() {
  local tag="$1"
  [ "$tag" = "latest" ] && tag=""
  if command -v gh >/dev/null 2>&1; then
    local args=(release download --repo "$REPO" --pattern "$ASSET" --dir "$BINDIR" --clobber)
    [ -n "$tag" ] && args=(release download "$tag" --repo "$REPO" --pattern "$ASSET" --dir "$BINDIR" --clobber)
    if gh "${args[@]}" >/dev/null 2>&1 && [ -f "$BINDIR/$ASSET" ]; then
      mv -f "$BINDIR/$ASSET" "$DEST"
      chmod +x "$DEST" 2>/dev/null || true
      log "installed prebuilt $ASSET from release $tag"
      return 0
    fi
  fi
  return 1
}

if try_release "$TAG"; then
  echo "$BINDIR" >> "${GITHUB_PATH:-/dev/null}" || true
  "$DEST" --version || true
  exit 0
fi

# --- 2. fall back to cargo install (pinned tag) ------------------------------
log "no prebuilt CLI asset for $ASSET at $TAG — building from source via cargo"
if ! command -v cargo >/dev/null 2>&1; then
  log "installing Rust toolchain (rustup)…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1090,SC1091
  . "$HOME/.cargo/env"
fi

GIT_REF="$TAG"
[ "$TAG" = "latest" ] && GIT_REF="main"

# digstore-cli's build.rs embeds the compiled guest wasm, so build that target
# first (BINDING contract D6). `cargo install` runs build.rs from a fresh clone,
# so we install from git and let cargo build the guest as part of the workspace.
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
log "cargo install digstore-cli @ $GIT_REF (this can take a few minutes)…"
cargo install \
  --git "https://github.com/${REPO}.git" \
  --tag "$GIT_REF" \
  --locked \
  digstore-cli 2>/dev/null \
  || cargo install \
       --git "https://github.com/${REPO}.git" \
       --branch "$GIT_REF" \
       --locked \
       digstore-cli

# `cargo install` drops the binary in ~/.cargo/bin which is already on PATH on runners.
if command -v digstore >/dev/null 2>&1; then
  digstore --version || true
fi
