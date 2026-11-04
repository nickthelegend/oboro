#!/usr/bin/env bash
# Restart one piece of the stack started by scripts/up.sh: tsuki or console. Re-reads .env.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
name=${1:?usage: scripts/restart.sh tsuki|console}
case $name in
  tsuki) cmd=(pnpm --filter @oboro/agents exec tsx src/seller.ts) ;;
  console) cmd=(pnpm --filter @oboro/dashboard exec tsx server.ts) ;;
  *) echo "Unknown piece: $name (tsuki or console)" >&2; exit 2 ;;
esac
while IFS= read -r line; do
  [[ "$line" =~ ^([A-Z0-9_]+)=(.*)$ ]] || continue
  value="${BASH_REMATCH[2]%%  #*}"; value="${value%"${value##*[![:space:]]}"}"
  [[ -n "$value" ]] && export "${BASH_REMATCH[1]}=$value"
done < .env
pid=$(awk -v n="$name" '$2==n{print $1}' .oboro/pids 2>/dev/null || true)
if [[ -n "$pid" ]]; then pkill -TERM -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; sleep 2; fi
grep -v -E " $name\$" .oboro/pids > .oboro/pids.tmp 2>/dev/null || true
"${cmd[@]}" > ".oboro/logs/$name.log" 2>&1 &
echo "$! $name" >> .oboro/pids.tmp
mv .oboro/pids.tmp .oboro/pids
echo "restarted $name ($!)"
