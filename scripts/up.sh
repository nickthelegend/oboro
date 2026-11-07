#!/usr/bin/env bash
# Start the whole Oboro stack on this machine: gateway (seller), gateway's gate, agent wallet's tunnel, the console.
# PIDs go to .oboro/pids; stop everything with scripts/down.sh. Logs go to .oboro/logs/.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
[[ -f .env ]] || { echo "Setup required: copy .env.example to .env and fill it in" >&2; exit 1; }
load_env() {
  while IFS= read -r line; do
  [[ "$line" =~ ^([A-Z0-9_]+)=(.*)$ ]] || continue
  value="${BASH_REMATCH[2]%%  #*}"; value="${value%"${value##*[![:space:]]}"}"
  [[ -n "$value" ]] && export "${BASH_REMATCH[1]}=$value"
  done < "$1"
}
load_env .env
# Optional overlay (e.g. a mainnet env kept outside the repo); its values win over .env.
[[ -n "${OBORO_ENV_OVERLAY:-}" ]] && load_env "$OBORO_ENV_OVERLAY"
node_bin="${OBORO_NODE_BIN:-crates/target/release/oboro-node}"
[[ -x "$node_bin" ]] || { echo "Setup required: build oboro-node (cargo build --release in crates/) or set OBORO_NODE_BIN" >&2; exit 1; }
mkdir -p .oboro/gate .oboro/tunnel .oboro/logs
: > .oboro/pids
start() { local name=$1; shift; "$@" > ".oboro/logs/$name.log" 2>&1 & echo "$! $name" >> .oboro/pids; }
pnpm --filter oboro build >/dev/null
pnpm --filter @oboro/wallet-app build >/dev/null
start gateway pnpm --filter @oboro/gateway exec tsx src/gateway.ts
start gate "$node_bin" gate --upstream http://127.0.0.1:7420 --data .oboro/gate --status 127.0.0.1:7411
start tunnel "$node_bin" tunnel --listen 127.0.0.1:7410 --data .oboro/tunnel
start console pnpm --filter @oboro/wallet-app exec tsx server.ts
echo "Waiting for both Nym clients to connect…"
for _ in $(seq 1 180); do
  if [[ -s .oboro/gate/address.txt ]] && curl -fsS http://127.0.0.1:7410/status >/dev/null 2>&1; then
    echo "gateway's Nym address: $(cut -c1-24 .oboro/gate/address.txt)…"
    echo "Console: http://127.0.0.1:7430/#/console"
    exit 0
  fi
  sleep 1
done
echo "Nym clients did not come up in 180 s; see .oboro/logs/" >&2
exit 1
