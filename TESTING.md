# Testing

Node 26, pnpm, strict TypeScript, ESM, Vitest. Install with `pnpm install`.

| Command | Purpose |
| --- | --- |
| `pnpm -r test` | 43 SDK unit tests, 20 shop tests, and 1 MCP tool registration test; 3 live SDK tests skip unless `OBORO_LIVE=1` |
| `pnpm -r build` | Compile all three TypeScript packages |
| `pnpm -r typecheck` | Strict typecheck all three packages |
| `pnpm --filter @oboro/agents setup:seller` | Export the seller UFVK to `.oboro/seller.ufvk` and create a view-only wallet; both files stay ignored and mode 600 |
| `OBORO_LIVE=1 bash apps/agents/scripts/live-sdk.sh` | Load ignored `.env`, read the actual buyer balance, and find a historical receipt in the seller view wallet |
| `OBORO_LIVE=1 bash apps/agents/scripts/demo.sh` | Paid end-to-end demo; run once only when `OBORO_NODE_BIN` exists |

The pure tests exercise Nym URL case preservation, x402 challenge and payment headers, policy checks before wallet access, persisted daily spend, paywall nonce and txid replay, expiry, pending, wrong memo, insufficient amount, error codes, and parsing of redacted shapes captured from the seller wallet's offline `messages`, `value_transfers`, and `balance` output. The agent and paywall unit tests simulate only the protocol state machine. They make no live-chain claim.

The live test uses the real buyer wallet path and a view-only copy of the seller's viewing key. The historical receipt is tx `656d03c9760ad158584cc2552cdb1d3d5c349ea0e766bcd5231485760dcdaa66`, an incoming 128,000-zat Ironwood transfer at height 4,548,940 in the seller wallet's cached records. Its memo predates Oboro, so the test checks discovery and parsing, not Oboro payment acceptance.

With `OBORO_ZINGO_SESSION=1`, the SDK keeps an interactive `--chain testnet --online` CLI per wallet directory. The seller defaults to this mode for its verifier. `OBORO_ZINGO_SESSION=0` keeps the spawn-per-call path (`--waitsync` for online calls). The existing global `/tmp/oboro-zingo.lock` serializes startup, and a per-wallet lock prevents another SDK CLI from opening the same wallet while its session is alive. The session checks `sync status` and the wallet height, then refreshes in the background about every 20 seconds. The verifier uses the completed scan height for confirmations; its session path does not use wallet-file mtime. There are no paid sends in the automated test suite.

## Persistent session result (2026-11-04)

The real seller **view-only** wallet `.oboro/seller-view` was opened interactively on Zcash testnet. Startup printed a server-selection sweep, `Launching sync task...`, then `(test) Block:0 [Syncing] >> `. A `height` command returned JSON followed by `(test) Block:4581235 [Syncing 648 / 648 outputs] >> `; the prompt is the command boundary. `sync status` returned JSON scan ranges and output percentages. `sync run` said `Sync task already running.` during the initial sync, so the online session already maintains a sync task. The unit framing fixture is a redacted capture of that output.

Read-only live timing, using `OBORO_LIVE=1` and no payment: first `height` including startup **18,328 ms**; second `height` **1 ms**; `ensureSynced(20_000)` **10,025 ms**; synced height **4,581,250**. The test closed the session and did not leave its wallet process running.

Changed files: `packages/sdk/src/session.ts`, `zingo.ts`, `verifier.ts`, `index.ts`, `packages/sdk/test/session.test.ts`, `packages/sdk/test/live.test.ts`, `apps/agents/src/seller.ts`, and this file. `pnpm -r test` passed **64 tests** (5 live tests skipped by default: 3 SDK, 2 shop); `pnpm -r typecheck` and `pnpm -r build` passed. The separate live session timing test passed once.

Limits: zingo's `sync status` reports the wallet's scanned range and percentage, not an independent remote chain tip or a completed network round-trip timestamp. The session treats a 100% scanned range covering its reported height as the completed local scan; network outage or an unresponsive Nym exit can still delay freshness, and `ensureSynced` fails after five minutes. This read-only timing check does not measure a paid call or confirmation latency. The in-process session registry and per-wallet advisory lock apply to SDK-managed CLIs; a CLI launched outside the SDK must respect the same wallet-dir exclusion.

## Shop

`packages/shop/test/shop.test.ts` covers captured real Bitrefill CLI search/details JSON, allow-list and cap decisions, out-of-stock refusal, atomic mode-600 ledger writes, replay refusal, phone/code masking, invoice versus order status, failure paths, and the 429 backoff schedule. These are pure tests and never buy.

`apps/agents/src/shop-routes.test.ts` checks that the free shop dashboard never exposes a receipt bearer token, approval ID, full phone, or unmasked code.

`OBORO_SHOP_LIVE_CATALOG=1 pnpm --filter @oboro/shop test` runs the no-key CLI search/details against the real Airtel India catalog and prints package denominations and USD prices. The key-only test calls `ping` and `balance` if `BITREFILL_API_KEY` is present; otherwise it skips with “Setup required: BITREFILL_API_KEY.” Neither live test creates an invoice.
