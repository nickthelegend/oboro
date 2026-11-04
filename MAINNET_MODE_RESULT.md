# Oboro mainnet mode result

## Files changed

- SDK: `packages/sdk/src/chain.ts`, `zingo.ts`, `session.ts`, `verifier.ts`, `protocol.ts`, `paywall.ts`, `agent.ts`.
- Agents: `apps/agents/src/seller.ts`, `apps/agents/scripts/setup-seller-viewkey.ts`, `apps/agents/scripts/new-wallet.ts`, `apps/agents/package.json`.
- Console: `apps/dashboard/server.ts`.
- Tests: `packages/sdk/test/chain.test.ts`, `protocol.test.ts`, `agent.test.ts`, `paywall.test.ts`, `session.test.ts`.
- This result: `MAINNET_MODE_RESULT.md`.

## Checks

- `pnpm -r test`: 76 passed, 5 live tests skipped (52 SDK, 21 shop, 2 MCP, 1 agents).
- `pnpm -r typecheck`: passed.
- `pnpm -r build`: passed.
- No live mainnet test or transaction was run. The existing stack was not stopped or restarted.

## Mainnet run commands

These commands are for a later cutover, after the operator has freed ports 7410/7411/7420/7430 and configured the Nym gate and tunnel for that deployment. Use separate mainnet wallet and state paths. The parent of each new wallet directory must already exist. `buyer` performs Kumo's existing paid tip and fee requests, so invoking it sends mainnet ZEC.

```sh
export OBORO_CHAIN=mainnet
export OBORO_ZINGO_CLI=/absolute/path/to/zingo-cli
export OBORO_LIGHTWALLETD=https://zec.rocks:443
export OBORO_SELLER_WALLET_DIR=/secure/oboro-mainnet/tsuki
export OBORO_BUYER_WALLET_DIR=/secure/oboro-mainnet/kumo
export OBORO_SELLER_VIEW_DIR=/secure/oboro-mainnet/tsuki-view
export OBORO_SELLER_UFVK_FILE=/secure/oboro-mainnet/tsuki.ufvk
export OBORO_PAYWALL_STATE=/secure/oboro-mainnet/paywall.json
export OBORO_SHOP_LEDGER=/secure/oboro-mainnet/shop.json
export OBORO_SPEND_FILE=/secure/oboro-mainnet/kumo-spend.json
export OBORO_TUNNEL_URL=http://127.0.0.1:7410
export OBORO_SELLER_NYM_ADDRESS=the-mainnet-deployment-tsuki-nym-address

pnpm --filter @oboro/agents wallet:new "$OBORO_SELLER_WALLET_DIR"
pnpm --filter @oboro/agents wallet:new "$OBORO_BUYER_WALLET_DIR"
export OBORO_SELLER_ADDRESS=the-u1-address-printed-for-tsuki
pnpm --filter @oboro/agents setup:seller
pnpm --filter @oboro/agents seller
```

In another terminal, with the same exported variables and the mainnet Nym tunnel running:

```sh
pnpm --filter @oboro/agents buyer
```

Omit `OBORO_CHAIN` for the existing testnet default. `OBORO_CHAIN=mainnet` is required even when a constructor passes `chain: 'mainnet'`.

## UI scope limit

`/api/state` and `/api/shop` expose `network` and `explorerBase` (`https://testnet.zcashexplorer.app/transactions/` or `https://mainnet.zcashexplorer.app/transactions/`). The dashboard's existing `apps/dashboard/src/api.ts` still hardcodes the testnet explorer URL. That protected source directory was not edited, so browser explorer links remain testnet links until a separate UI change uses `explorerBase`.
