#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
umask 077
[[ -f .env ]] || { echo "Setup required: .env" >&2; exit 1; }
[[ "${OBORO_LIVE:-}" == 1 ]] || { echo "Setup required: OBORO_LIVE=1 (demo spends testnet ZEC)" >&2; exit 1; }
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  export "$key=$value"
done < .env
node_bin="${OBORO_NODE_BIN:-/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-target/release/oboro-node}"
[[ -x "$node_bin" ]] || { echo "Setup required: OBORO_NODE_BIN" >&2; exit 1; }
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM
mkdir -p .oboro/gate .oboro/tunnel
node apps/gateway/dist/src/gateway.js & pids+=("$!")
"$node_bin" gate --upstream http://127.0.0.1:7420 --data .oboro/gate --status 127.0.0.1:7411 & pids+=("$!")
"$node_bin" tunnel --listen 127.0.0.1:7410 --data .oboro/tunnel & pids+=("$!")
for i in {1..180}; do
  if [[ -s .oboro/gate/address.txt ]] && curl -fsS http://127.0.0.1:7410/status >/dev/null 2>&1; then break; fi
  sleep 1
done
[[ -s .oboro/gate/address.txt ]] || { echo "Gate did not publish its Nym address" >&2; exit 1; }
nym_address="${OBORO_SELLER_NYM_ADDRESS:-$(cat .oboro/gate/address.txt)}"
pnpm --filter @oboro/example-paid-api-agent start "$nym_address"
