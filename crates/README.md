# Oboro node

This workspace has its own `Cargo.lock` and depends on Nym SDK 1.22.3 (git tag `nym-binaries-v2026.21-hanoi`; not on crates.io yet). It has no Zcash dependency. The gate holds a stable Nym identity in `<data>/nym`; the tunnel does the same in its own data directory. The gate's upstream should bind to loopback only.

```sh
cd crates
export CARGO_BUILD_JOBS=4
export CARGO_TARGET_DIR='/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-target'
# On the sandboxed build machine only, use a writable Cargo registry:
export CARGO_HOME='/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-cargo'
cargo test
cargo test --test live_roundtrip -- --ignored --nocapture
cargo run --bin oboro-node -- gate --upstream http://127.0.0.1:7420 --data /tmp/oboro-gate --status 127.0.0.1:7411
cargo run --bin oboro-node -- tunnel --listen 127.0.0.1:7410 --data /tmp/oboro-tunnel
# Copy address.txt from the gate data directory, URL-encode it as one path segment:
curl -i "http://127.0.0.1:7410/nym/$(cat /tmp/oboro-gate/address.txt)/oboro/ping"
cargo run --bin oboro-node -- probe --to "$(cat /tmp/oboro-gate/address.txt)"
```

`--nym-env <file>` loads a Nym network environment file before connecting. `--timeout-secs` controls the tunnel request/response timeout (default 180 seconds). Gate request reads time out after 120 seconds. Each HTTP request opens a fresh Nym stream and exchanges one length-prefixed JSON request and response. The 4-byte big-endian frame length is capped at 4 MiB. HTTP hop-by-hop and host headers are removed. `/status` and `/events?since=<seq>` are local endpoints; the gate appends event metadata to `<data>/events.jsonl` without bodies or header values.

Nym streams have no close/EOF message. Oboro relies on length framing, drops streams after one exchange, and depends on the SDK's idle cleanup for remote streams abandoned mid-exchange.
