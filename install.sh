#!/bin/sh
# Install cocseak from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/Manifestro/cocseak/main/install.sh | sh
#
# COCSEAK_VERSION picks a release (default: the latest), COCSEAK_PREFIX where it goes
# (default: ~/.local, so the command lands in ~/.local/bin).
set -eu

REPO="Manifestro/cocseak"
VERSION="${COCSEAK_VERSION:-latest}"
PREFIX="${COCSEAK_PREFIX:-$HOME/.local}"

fail() {
  printf 'cocseak install: %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required (https://nodejs.org)"
command -v npm >/dev/null 2>&1 || fail "npm is required; it ships with Node.js"
command -v curl >/dev/null 2>&1 || fail "curl is required"

major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || fail "Node.js 22 or newer is required, found $(node --version)"

case "$VERSION" in
  latest) base="https://github.com/$REPO/releases/latest/download" ;;
  v*) base="https://github.com/$REPO/releases/download/$VERSION" ;;
  *) base="https://github.com/$REPO/releases/download/v$VERSION" ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

printf 'Downloading cocseak (%s)...\n' "$VERSION"
curl -fsSL "$base/cocseak.tgz" -o "$tmp/cocseak.tgz" || fail "could not download $base/cocseak.tgz"
curl -fsSL "$base/cocseak.tgz.sha256" -o "$tmp/cocseak.tgz.sha256" || fail "could not download the checksum"

expected=$(cut -d ' ' -f 1 < "$tmp/cocseak.tgz.sha256")
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/cocseak.tgz" | cut -d ' ' -f 1)
else
  actual=$(sha256sum "$tmp/cocseak.tgz" | cut -d ' ' -f 1)
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch: the download is not the released archive"

npm install --global --prefix "$PREFIX" --no-fund --no-audit --loglevel=error "$tmp/cocseak.tgz" \
  || fail "npm could not install the archive"

printf 'Installed cocseak %s to %s/bin/cocseak\n' "$("$PREFIX/bin/cocseak" --version)" "$PREFIX"
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) printf 'Add %s/bin to your PATH to run it as `cocseak`.\n' "$PREFIX" ;;
esac
printf 'Next: cocseak doctor\n'
