#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${OBORO_LIVE:-}" == 1 ]] || { echo "Setup required: OBORO_LIVE=1" >&2; exit 1; }
[[ -f .env ]] || { echo "Setup required: .env" >&2; exit 1; }
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  export "$key=$value"
done < .env
exec pnpm --filter oboro test
