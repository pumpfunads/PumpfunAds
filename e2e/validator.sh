#!/usr/bin/env bash
# Local validator with pump.fun, pump fees, PumpSwap and mayhem cloned from mainnet (account list: e2e/clones.txt,
# made by e2e/clone-list.mjs from the instructions Ads really builds).
# ⛔ Other sessions run validators too (Hooker 8897, Switch 8999, Pairs 8993): Ads uses 8994; stop it by its port, never pkill.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/share/solana/install/releases/4.0.0/solana-release/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
: "${CLONE_RPC_URL:?set CLONE_RPC_URL (a keyed mainnet RPC)}"
PORT="${LOCAL_RPC_PORT:-8994}"
rm -rf ledger
# shellcheck disable=SC2046
exec solana-test-validator --url "$CLONE_RPC_URL" --rpc-port "$PORT" --faucet-port $((PORT + 3)) --gossip-port $((PORT + 5)) \
  --dynamic-port-range $((PORT + 10))-$((PORT + 40)) --ledger ledger --reset --quiet $(cat clones.txt)
