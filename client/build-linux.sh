#!/usr/bin/env bash
# Builds the Linux AppImage of the Liro client. Run on any x86_64 Linux (or WSL) with Node.js >= 18:
#   ./build-linux.sh
# Result: dist/Liro-<version>-linux-x86_64.AppImage
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null; then
  echo "Node.js >= 18 is required (e.g. sudo apt install nodejs npm)" >&2
  exit 1
fi

npm ci --no-fund --no-audit || npm install --no-fund --no-audit
npm run dist:linux
ls -lh dist/*.AppImage
