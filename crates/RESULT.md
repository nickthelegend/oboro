# Oboro node implementation result

No `-o` result path was supplied with the brief, so this file is `crates/RESULT.md`.

Files created:

- `Cargo.toml`, `Cargo.lock` — isolated workspace and dependency lockfile
- `oboro-node/Cargo.toml`, `oboro-node/src/lib.rs`, `oboro-node/src/main.rs`, `oboro-node/src/wire.rs`
- `oboro-node/tests/live_roundtrip.rs`
- `README.md`, `smoke.sh`, `RESULT.md`

All work is within `crates/`. The build cache is under `/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-target`, and a writable Cargo registry mirror is under `/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-cargo`. No commits were made.

## Exact commands

```sh
cd '/Volumes/Extreme SSD/Projects/grokbot/projects/oboro/crates'
CARGO_HOME='/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-cargo' CARGO_BUILD_JOBS=4 CARGO_TARGET_DIR='/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-target' cargo test --no-run
CARGO_HOME='/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-cargo' CARGO_BUILD_JOBS=4 CARGO_TARGET_DIR='/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-target' cargo test -- --nocapture
CARGO_HOME='/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-cargo' CARGO_BUILD_JOBS=4 CARGO_TARGET_DIR='/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-target' cargo test --test live_roundtrip -- --ignored --nocapture
CARGO_HOME='/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-cargo' CARGO_BUILD_JOBS=4 CARGO_TARGET_DIR='/Volumes/Extreme SSD/Projects/grokbot/tools/oboro-target' cargo build --bin oboro-node
./smoke.sh
```

The initial build with the default Cargo home failed because the sandbox denied writes to `~/.cargo/registry/cache`. A writable Cargo home fixed that. The initial dependency resolution mixed Nym `1.21.4` with `1.22.x` and failed in `nym-client-core`; the final workspace lockfile aligns the Nym SDK family to `1.21.4`.

## Unit tests

Final `cargo test -- --nocapture`: **5 passed, 0 failed**; the live integration test was ignored by default. Covered frame round trip, oversize rejection, truncated frame, hop-by-hop and IP-forwarding header stripping, valid recipient path and query parsing, root path, and bad recipient rejection.

## Real Nym mainnet integration

First live run passed (one gate and one tunnel in separate temporary data dirs, local axum upstream):

```text
GET /free: status=200 OK ms=2978 body={"free":true}
GET /paid: status=402 Payment Required ms=4577 body=payment required
POST /echo: status=200 OK ms=3591 bytes=20480
test result: ok. 1 passed; 0 failed; finished in 21.64s
```

The test asserts byte-for-byte bodies, the upstream's `x-oboro-transport: nym-mixnet`, and absence of `x-forwarded-for`, `x-real-ip`, and `forwarded` headers.

A second live run failed on the first GET: the gate accepted a stream open but timed out reading the request frame after 120 seconds (`gate stream error: request read timeout (120s): deadline has elapsed`). The tunnel returned `504 Gateway Timeout` after 240896 ms with `{"error":"mixnet_timeout","ms":240278}`. The test correctly failed its expected-200 assertion, finishing in 249.72s.

A third live run passed GET `/free` (`200 OK`, 3231 ms, body `{"free":true}`), then failed on GET `/paid`. The gate again logged `request read timeout (120s): deadline has elapsed`; the tunnel returned `504 Gateway Timeout` after 240712 ms with `{"error":"mixnet_timeout","ms":240199}`. The test failed its expected-402 assertion, finishing in 254.57s. These are real mixnet delivery failures, not mocked results. The final source passed the unit suite and compiled after these runs; the only subsequent code changes were upstream redirect handling, event sequence ordering, and counting malformed responses as errors.

## Real binary smoke check

`./smoke.sh` started `python3 -m http.server` on `127.0.0.1:7420`, the gate on status port `7411`, and the tunnel on port `7410`. It called `curl -sS -i --max-time 200 "http://127.0.0.1:7410/nym/$addr/"`. Its final output was:

```text
HTTP/1.1 200 OK
server: SimpleHTTP/0.6 Python/3.14.7
content-type: text/html
content-length: 12
x-oboro-mix-ms: 1483
x-oboro-stream: StreamId(0xe60199c47f788705)

oboro smoke
```

The script records each child PID, kills and waits for all three on exit, and removes its temporary data directory. Temporary directories from the two initial smoke runs were also removed. The first smoke run exposed that Axum's wildcard route does not match `/nym/<address>/`; an explicit root route fixed it, and the second run passed.

## Nym SDK stream limitations

Nym SDK streams have no close/EOF message, so Oboro uses 4-byte length frames and one request/response per stream. Dropped streams rely on the SDK's local deregistration and idle cleanup. SDK `open_stream` requires mutable access and is not cancel safe; the tunnel mutex serializes only stream creation, while opened streams run concurrently. The request/response wait has a timeout, but `open_stream` itself is not wrapped in a cancellable timeout.

In two of three live integration attempts, the gate received the stream open but not the request data frame within 120 seconds. The tunnel then returned a 504 at 240 seconds. The SDK stream protocol does not provide an explicit close signal; its architecture document describes reordering but no application-level retry. Oboro does not automatically retry HTTP requests because replaying a POST could duplicate upstream effects.

## Fix for the stalled runs (Claude, 11:29 IST)

Cause: nym-sdk 1.21.4's stream router silently drops a `Data` frame whose stream the receiver has not yet
registered (`StreamMap::send_to_stream` finds no entry). Registration happens in `MixnetListener::accept()`, while
the tunnel wrote the request right after `open_stream`. Through the mixnet, the data frame could arrive before the
gate's accept loop registered the stream.

Fix: a ready handshake. The gate writes a `{"v":1,"ready":true}` frame as soon as it accepts a stream, and the tunnel
and probe wait for it before sending the request. Unit test `ready_then_request_on_one_stream` covers the ordering.

Live result after the fix: 3 runs × 3 requests, all passed.

```text
run 1: GET /free 200 7640 ms · GET /paid 402 3950 ms · POST /echo 200 5538 ms (20480 bytes)
run 2: GET /free 200 5745 ms · GET /paid 402 3943 ms · POST /echo 200 5396 ms
run 3: GET /free 200 5074 ms · GET /paid 402 3492 ms · POST /echo 200 7230 ms
```

## 2026-11-04: MCP shop tools and nym-sdk 1.22.3

**Part 1 files:** `../packages/mcp/src/server.ts`, `../packages/mcp/test/server.test.ts`, and `../packages/mcp/README.md`. The server now registers seven tools: the existing fetch, budget, and status tools plus shop search, product, buy, and receipt. The buy call uses the existing `createAgent().fetch` spend policy, polls a `processing` receipt for up to five minutes, and masks all redemption field values before returning them to MCP clients. The receipt tool applies the same mask. The registration test checks all seven schemas; a pure test checks the masking rule. `pnpm -r test` passed: 67 tests passed across the workspace, 5 skipped; `pnpm -r typecheck` and `pnpm -r build` passed. No paid shop purchase was attempted in these checks.

**Part 2 files:** `oboro-node/Cargo.toml`, `Cargo.lock`, and `oboro-node/RESULT.md`. Direct Nym dependency: `nym-sdk 1.22.3` from Git tag `nym-binaries-v2026.21-hanoi` (`f92749c5`), replacing `1.21.4`; the Nym transitive crates are aligned at 1.22.3. The upstream lockfile was used to resolve the yanked `tokio_with_wasm 0.10.1`. The stream source findings are detailed in `oboro-node/RESULT.md`: early data is now buffered within limits before `accept()`, there is `OpenAck`/`wait_established`, and there is still no wire Close/EOF. Oboro's Ready handshake remains. `cargo test` passed 6 unit tests (1 real-mixnet test ignored by default); `cargo build --release` passed with no Rust source changes. A fresh gate/tunnel and throwaway local upstream returned HTTP 200 for three real-Nym requests in **4.607048 s, 2.146880 s, and 3.219396 s**. All three started processes were killed by PID, and `/private/tmp/oboro-122/` was removed.

**Path constraint:** the requested Cargo home under `/Volumes/Extreme SSD/Projects/grokbot/tools/` was not writable in this sandbox (`Operation not permitted` while creating its Git checkout). The verification used `/private/tmp/oboro-122-cargo` and `/private/tmp/oboro-122-target`, separate from the running stack's target directory. Those temporary build caches are removed after verification.

**Left:** Claude can review and commit these changes. A real paid shop purchase and delivery remain untested here because they would spend the operator's live event credits; the requested MCP checks covered registration, masking, types, and build. No commit was made.
