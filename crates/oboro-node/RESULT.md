# nym-sdk stream upgrade — 2026-11-04 IST

Version tested: `nym-sdk 1.22.3`, from `nym-binaries-v2026.21-hanoi` (`f92749c5`) in `nymtech/nym`. Previous version: crates.io `nym-sdk 1.21.4`. Oboro has no other direct `nym-*` dependencies. The 1.22.3 SDK and its Nym workspace dependencies resolve from the Git tag.

## Stream API and behavior

- `MixnetClient::open_stream` and `MixnetListener::accept` still produce an `AsyncRead + AsyncWrite` `MixnetStream`. The client still opens with an empty `Open` frame; the receiver's `accept()` registers the stream and supplies any `Open` initial data to the read buffer. The stream still supports initial data on `Open` internally, but Oboro's public `open_stream` call does not pass initial data.
- `accept()` now sends a best-effort `OpenAck`. `MixnetStream::wait_established(timeout)` can wait for that acknowledgment or inbound data. The SDK adds per-stream reordering, bounded data-loss reporting, keepalive ping/pong, and a liveness check. `open_stream` now rejects an unroutable recipient at dial time.
- **Early data:** 1.21.4's router silently discarded a `Data` frame for an unregistered stream. In 1.22.3, `StreamMap::send_to_stream` calls `buffer_orphan`; `register_stream` drains those orphan frames into the ordered stream channel. The buffer holds up to 32 frames per stream for 64 streams, with a nominal 5-second TTL (swept at most 10 seconds later). So data arriving shortly before `accept()` is buffered, but data outside those limits can still be dropped. Oboro retains its application Ready handshake to protect its request frame across mixnet delays and SDK versions.
- **Close/EOF:** the wire `SphinxStreamMsgType` variants are `Open`, `Data`, `OpenAck`, `Ping`, and `Pong`. There is still no peer Close/EOF frame. `poll_shutdown` and `Drop` deregister local state only. A read sees EOF when its local channel closes after teardown or idle cleanup, not a reliable remote close notification. Oboro keeps one framed request and response per stream.

Source inspected: `sdk/rust/nym-sdk/src/mixnet/stream/{mod.rs,mixnet_stream.rs,protocol.rs}` and `common/nym-lp-data/src/packet/frame.rs` at the tag, compared with crates.io `nym-sdk 1.21.4` source.

## Build and live check

`cargo test`: 6 unit tests passed; one real-mixnet integration test was ignored by default. `cargo build --release`: passed in 3m 44s. No Rust source changes were needed.

The new release binary alone ran a gate on status port 7511 and a tunnel on 7510, with a throwaway Python HTTP upstream on 7521. All three requests through the real Nym mixnet returned HTTP 200:

| Request | Latency |
| --- | ---: |
| 1 | 4.607048 s |
| 2 | 2.146880 s |
| 3 | 3.219396 s |

The upstream, gate, and tunnel were stopped by their recorded PIDs. `/private/tmp/oboro-122/` was deleted; ports 7510, 7511, and 7521 have no listeners. The live Oboro stack on ports 7410/7411/7420/7430 was untouched.

The requested Cargo home and target paths under `/Volumes/Extreme SSD/Projects/grokbot/tools/` were denied by the workspace sandbox (`Operation not permitted` creating the Git checkout). The build used isolated `/private/tmp/oboro-122-cargo` and `/private/tmp/oboro-122-target` instead; the running release binary and its target directory were untouched. The first resolver attempt also failed because `tokio_with_wasm 0.10.1` is yanked. Seeding the local lockfile from the upstream tag's lockfile retained that version's checksum and allowed resolution.
