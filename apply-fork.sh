#!/usr/bin/env bash
# Build the Hister attention fork: copy the installed Hister extension, append
# the attention module to its service worker, and patch the manifest. Idempotent
# — safe to re-run after Hister updates on the Web Store.
#
#   ./apply-fork.sh            # auto-locate the installed extension
#   SRC=/path/to/unpacked ./apply-fork.sh
#
# Output: extension/build/  → load that folder via chrome://extensions (unpacked).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ID=cciilamhchpmbdnniabclekddabkifhb   # Hister on the Chrome Web Store
BUILD="$HERE/extension/build"

if [ -z "${SRC:-}" ]; then
  SRC="$(ls -d "$HOME/Library/Application Support/Google/Chrome/"*"/Extensions/$ID/"*/ 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "${SRC:-}" ] || [ ! -f "$SRC/manifest.json" ]; then
  echo "ERROR: could not find the installed Hister extension." >&2
  echo "Install Hister from the Chrome Web Store first, or pass SRC=/path/to/unpacked." >&2
  exit 1
fi

echo "source : $SRC"
rm -rf "$BUILD"; mkdir -p "$BUILD"
cp -R "$SRC"/. "$BUILD"/

# Fork = append our module (never edit their minified code) + patch the manifest.
printf '\n' >> "$BUILD/background.js"
cat "$HERE/extension/attention.append.js" >> "$BUILD/background.js"
node "$HERE/extension/patch-manifest.mjs" "$BUILD/manifest.json"

echo
echo "Built: $BUILD"
echo "Next:"
echo "  1. chrome://extensions → remove/disable the Web Store 'Hister' (avoid double-capture)"
echo "  2. Enable Developer mode → Load unpacked → select: $BUILD"
echo "  3. Make sure the hister-attn service is running (./install.sh)"
