#!/usr/bin/env bash
# The REAL site against the REAL API on the local validator (no mock data): runs e2e/api.mjs into a kept directory
# (two launched coins, fees split, a sale, content made in mock mode), then serves the built site from that database on
# http://127.0.0.1:5420. Needs e2e/validator.sh running (port 8994).
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${ADS_E2E_DIR:-/tmp/ads-local}"
rm -rf "$DIR"; mkdir -p "$DIR"
ADS_E2E_DIR="$DIR" node e2e/api.mjs | tail -1
npm run build >/dev/null
echo "serving on http://127.0.0.1:5420 (Ctrl-C to stop)"
SOLANA_RPC=http://127.0.0.1:8994 DB_PATH="$DIR/ads.db" MEDIA_DIR="$DIR/media" VANITY_GRIND=0 VANITY_INCOMING="$DIR/in" PORT=5420 \
  ADS_MASTER_KEY="$(cat "$DIR/dev-master.key" 2>/dev/null || true)" ADMIN_TOKEN=local-admin-token-0123456789 exec node api/server.mjs
