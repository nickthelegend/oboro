# Testing

Node 26, pnpm, strict TypeScript, ESM, Vitest. Install with `pnpm install`.

| Command | Purpose |
| --- | --- |
| `pnpm -r test` | 34 SDK pure unit tests and 1 MCP tool registration test; 2 live tests skip unless `OBORO_LIVE=1` |
| `pnpm -r build` | Compile all three TypeScript packages |
| `pnpm -r typecheck` | Strict typecheck all three packages |
| `pnpm --filter @oboro/agents setup:seller` | Export the seller UFVK to `.oboro/seller.ufvk` and create a view-only wallet; both files stay ignored and mode 600 |
| `OBORO_LIVE=1 bash apps/agents/scripts/live-sdk.sh` | Load ignored `.env`, read the actual buyer balance, and find a historical receipt in the seller view wallet |
| `OBORO_LIVE=1 bash apps/agents/scripts/demo.sh` | Paid end-to-end demo; run once only when `OBORO_NODE_BIN` exists |

The pure tests exercise Nym URL case preservation, x402 challenge and payment headers, policy checks before wallet access, persisted daily spend, paywall nonce and txid replay, expiry, pending, wrong memo, insufficient amount, error codes, and parsing of redacted shapes captured from the seller wallet's offline `messages`, `value_transfers`, and `balance` output. The agent and paywall unit tests simulate only the protocol state machine. They make no live-chain claim.

The live test uses the real buyer wallet path and a view-only copy of the seller's viewing key. The historical receipt is tx `656d03c9760ad158584cc2552cdb1d3d5c349ea0e766bcd5231485760dcdaa66`, an incoming 128,000-zat Ironwood transfer at height 4,548,940 in the seller wallet's cached records. Its memo predates Oboro, so the test checks discovery and parsing, not Oboro payment acceptance.

All online zingo calls use `--chain testnet --online --waitsync` with the shared `/tmp/oboro-zingo.lock`. The verifier may accept a recently saved wallet snapshot when the requested note already has at least three confirmations; otherwise it starts an online sync. A live view-wallet sync may take several minutes or fail when the Nym exit is unavailable. There are no paid sends in the automated test suite.
