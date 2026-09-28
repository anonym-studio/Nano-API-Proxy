#!/usr/bin/env bash
# Registers the Nano API Proxy Native Messaging Host for the current user on macOS/Linux
# (spec §5 item 7). Native Messaging Host manifests pin allowed_origins to a specific extension
# ID (wildcards aren't allowed), so this script needs that ID as an argument.
#
# Usage:
#   1. Load this repo as an unpacked extension (chrome://extensions -> Developer mode -> Load
#      unpacked) and copy the extension ID shown there.
#   2. (cd host && go build -o bin/nano-proxy-host .)
#   3. ./install.sh <extension-id>
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <chrome-extension-id>" >&2
  exit 1
fi

EXTENSION_ID="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY_PATH="$SCRIPT_DIR/host/bin/nano-proxy-host"
HOST_NAME="com.local.nano.proxy"
MANIFEST_TEMPLATE="$SCRIPT_DIR/host-manifest.template.json"

if [ ! -x "$BINARY_PATH" ]; then
  echo "error: $BINARY_PATH not found or not executable. Build it first:" >&2
  echo "  (cd host && go build -o bin/nano-proxy-host .)" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required to render the host manifest JSON." >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    ;;
  *)
    echo "error: unsupported OS for this script. Use install.ps1 on Windows." >&2
    exit 1
    ;;
esac

mkdir -p "$TARGET_DIR"
TARGET_FILE="$TARGET_DIR/$HOST_NAME.json"

python3 - "$MANIFEST_TEMPLATE" "$TARGET_FILE" "$BINARY_PATH" "$EXTENSION_ID" <<'PY'
import json
import sys

template_path, target_path, binary_path, extension_id = sys.argv[1:5]
with open(template_path, encoding="utf-8") as f:
    manifest = json.load(f)
manifest["path"] = binary_path
manifest["allowed_origins"] = [f"chrome-extension://{extension_id}/"]
with open(target_path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY

echo "Installed Native Messaging Host manifest: $TARGET_FILE"
echo "  path:            $BINARY_PATH"
echo "  allowed_origins: chrome-extension://$EXTENSION_ID/"
