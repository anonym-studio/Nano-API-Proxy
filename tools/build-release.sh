#!/usr/bin/env bash
# Builds a distributable zip for a GitHub Release. Takes a clean snapshot of the committed tree
# via `git archive` (so untracked/.gitignore'd files like host/bin/ dev binaries, .DS_Store, etc.
# never leak into the package) and adds freshly cross-compiled Native Messaging Host binaries for
# the common desktop platforms, so most users don't need Go installed to use Mode B.
#
# Usage: ./tools/build-release.sh [version]
#   version defaults to the "version" field in manifest.json.
# Output: dist/nano-api-proxy-<version>.zip
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required to read manifest.json." >&2
  exit 1
fi
if ! command -v go >/dev/null 2>&1; then
  echo "error: go is required to cross-compile the native messaging host." >&2
  exit 1
fi
if ! command -v zip >/dev/null 2>&1; then
  echo "error: zip is required." >&2
  exit 1
fi

VERSION="${1:-$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")}"
PKG_NAME="nano-api-proxy-$VERSION"
DIST_DIR="$REPO_DIR/dist"
STAGE_DIR="$DIST_DIR/$PKG_NAME"

echo "==> Building release package: $PKG_NAME"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

echo "==> Snapshotting committed tree (HEAD) into dist/$PKG_NAME"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "warning: working tree has uncommitted changes; the release package only includes what's committed to HEAD." >&2
fi
git archive --format=tar HEAD | tar -x -C "$STAGE_DIR"

echo "==> Renaming the Japanese-named spec doc to an ASCII filename (zip UTF-8 filename support is inconsistent across unzip tools, notably on Windows, and produces mojibake for non-ASCII names)"
SPEC_SRC=$(find "$STAGE_DIR/docs" -maxdepth 1 -name '*.md' ! -name 'manual.md')
if [ -n "$SPEC_SRC" ]; then
  mv "$SPEC_SRC" "$STAGE_DIR/docs/spec-ja.md"
  python3 - "$STAGE_DIR" "$(basename "$SPEC_SRC")" <<'PY'
import pathlib
import sys

stage = pathlib.Path(sys.argv[1])
old_name = sys.argv[2]

replacements = [
    (stage / "README.md", f"<docs/{old_name}>", "<docs/spec-ja.md>"),
    (stage / "docs" / "manual.md", f"<{old_name}>", "<spec-ja.md>"),
]
for path, old, new in replacements:
    text = path.read_text(encoding="utf-8")
    if old not in text:
        print(f"warning: expected link text not found in {path}", file=sys.stderr)
        continue
    path.write_text(text.replace(old, new), encoding="utf-8")
PY
fi

echo "==> Cross-compiling native messaging host for common platforms"
mkdir -p "$STAGE_DIR/host/bin"
TARGETS=("darwin amd64" "darwin arm64" "linux amd64" "linux arm64" "windows amd64")
for target in "${TARGETS[@]}"; do
  read -r goos goarch <<< "$target"
  out="$STAGE_DIR/host/bin/nano-proxy-host-$goos-$goarch"
  [ "$goos" = "windows" ] && out="${out}.exe"
  echo "    $goos/$goarch -> $(basename "$out")"
  (cd host && GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 go build -o "$out" .)
done
chmod +x "$STAGE_DIR"/host/bin/nano-proxy-host-* 2>/dev/null || true

echo "==> Zipping"
(cd "$DIST_DIR" && rm -f "$PKG_NAME.zip" && zip -rq "$PKG_NAME.zip" "$PKG_NAME")

echo "==> Done: dist/$PKG_NAME.zip"
du -h "$DIST_DIR/$PKG_NAME.zip"
