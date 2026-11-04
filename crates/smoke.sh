#!/bin/bash
set -eu
node='/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-target/debug/oboro-node'
smoke_dir=$(mktemp -d /private/tmp/oboro-smoke.XXXXXX)
mkdir -p "$smoke_dir/www" "$smoke_dir/gate" "$smoke_dir/tunnel"
printf 'oboro smoke\n' > "$smoke_dir/www/index.html"
python3 -m http.server 7420 --bind 127.0.0.1 --directory "$smoke_dir/www" > "$smoke_dir/upstream.log" 2>&1 &
upstream_pid=$!
"$node" gate --upstream http://127.0.0.1:7420 --data "$smoke_dir/gate" --status 127.0.0.1:7411 > "$smoke_dir/gate.log" 2>&1 &
gate_pid=$!
"$node" tunnel --listen 127.0.0.1:7410 --data "$smoke_dir/tunnel" > "$smoke_dir/tunnel.log" 2>&1 &
tunnel_pid=$!
cleanup() {
  kill "$upstream_pid" "$gate_pid" "$tunnel_pid" 2>/dev/null || true
  wait "$upstream_pid" "$gate_pid" "$tunnel_pid" 2>/dev/null || true
  python3 - "$smoke_dir" <<'PY'
import pathlib, shutil, sys
path = pathlib.Path(sys.argv[1])
if path.parent == pathlib.Path('/private/tmp') and path.name.startswith('oboro-smoke.'):
    shutil.rmtree(path)
PY
}
trap cleanup EXIT INT TERM
for i in {1..90}; do
  if [[ -s "$smoke_dir/gate/address.txt" ]] && curl -fsS --max-time 1 http://127.0.0.1:7410/status >/dev/null 2>&1; then break; fi
  if ! kill -0 "$gate_pid" 2>/dev/null || ! kill -0 "$tunnel_pid" 2>/dev/null; then
    cat "$smoke_dir/gate.log" "$smoke_dir/tunnel.log"
    exit 1
  fi
  sleep 1
done
if [[ ! -s "$smoke_dir/gate/address.txt" ]]; then
  cat "$smoke_dir/gate.log" "$smoke_dir/tunnel.log"
  exit 1
fi
cat "$smoke_dir/gate.log" "$smoke_dir/tunnel.log"
addr=$(cat "$smoke_dir/gate/address.txt")
curl -sS -i --max-time 200 "http://127.0.0.1:7410/nym/$addr/"
