#!/usr/bin/env bash
# Restart one piece of the stack started by scripts/up.sh: tsuki, console, gate or tunnel. Re-reads .env.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
name=${1:?usage: scripts/restart.sh tsuki|console|gate|tunnel}
case $name in
  tsuki) cmd=(pnpm --filter @oboro/agents exec tsx src/seller.ts) ;;
  console) cmd=(pnpm --filter @oboro/dashboard exec tsx server.ts) ;;
  gate|tunnel) ;;
  *) echo "Unknown piece: $name (tsuki, console, gate or tunnel)" >&2; exit 2 ;;
esac
while IFS= read -r line; do
  [[ "$line" =~ ^([A-Z0-9_]+)=(.*)$ ]] || continue
  value="${BASH_REMATCH[2]%%  #*}"; value="${value%"${value##*[![:space:]]}"}"
  [[ -n "$value" ]] && export "${BASH_REMATCH[1]}=$value"
done < .env
node_bin="${OBORO_NODE_BIN:-crates/target/release/oboro-node}"
[[ $name == gate ]] && cmd=("$node_bin" gate --upstream http://127.0.0.1:7420 --data .oboro/gate --status 127.0.0.1:7411)
[[ $name == tunnel ]] && cmd=("$node_bin" tunnel --listen 127.0.0.1:7410 --data .oboro/tunnel)
pid=$(awk -v n="$name" '$2==n{print $1}' .oboro/pids 2>/dev/null || true)
if [[ -n "$pid" ]]; then pkill -TERM -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; sleep 2; fi
# zingo-cli wrappers outlive a killed Tsuki (re-parented to init) and hold the wallet lock; stop them too.
if [[ $name == tsuki ]]; then
  for o in $(ps -ax -o pid=,ppid=,command= | awk '$2==1 && /oboro-zingo|zingo-cli/ {print $1}'); do pkill -TERM -P "$o" 2>/dev/null || true; kill -TERM "$o" 2>/dev/null || true; done
fi
grep -v -E " $name\$" .oboro/pids > .oboro/pids.tmp 2>/dev/null || true
"${cmd[@]}" > ".oboro/logs/$name.log" 2>&1 &
echo "$! $name" >> .oboro/pids.tmp
mv .oboro/pids.tmp .oboro/pids
echo "restarted $name ($!)"
