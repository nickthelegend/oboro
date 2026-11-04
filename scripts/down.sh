#!/usr/bin/env bash
# Stop everything scripts/up.sh started.
cd "$(dirname "$0")/.."
[[ -f .oboro/pids ]] || { echo "Nothing to stop"; exit 0; }
while read -r pid name; do
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null && echo "stopped $name ($pid)" || true
done < .oboro/pids
rm -f .oboro/pids
