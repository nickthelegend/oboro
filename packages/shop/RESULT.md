# Shop implementation result (4 Nov 2026)

## Files

- `packages/shop/src/shop.ts`, `src/index.ts`, `package.json`, `tsconfig.json`: Bitrefill REST/CLI client, guardrails, atomic ledger, invoice/order worker.
- `packages/shop/test/shop.test.ts`, `test/live.test.ts`, `test/fixtures/airtel-search.json`, `test/fixtures/airtel-details.json`: pure tests and captured live CLI catalog JSON.
- `apps/agents/src/shop-routes.test.ts`: free dashboard privacy test.
- `packages/shop/README.md`, `FEEDBACK_NOTES.md`: setup, privacy, approval flow, and builder friction.
- `apps/agents/src/shop-routes.ts`: free catalog, paid buy, bearer-token receipt, masked dashboard endpoint.
- `apps/agents/scripts/shop-approve.ts`: out-of-band human approval command.
- `apps/agents/package.json`, `pnpm-lock.yaml`: workspace package link and approval script.
- `TESTING.md`: Shop testing section.

## Commands and results

- `npm_config_cache=/private/tmp/oboro-npm-cache npx --yes @bitrefill/cli@0.3.0 --json search-products --query airtel --country IN --intent 'Find Airtel India prepaid talktime for a guarded demo shop'`: passed; captured fixture.
- `npm_config_cache=/private/tmp/oboro-npm-cache npx --yes @bitrefill/cli@0.3.0 --json get-product-details --product_id airtel-india`: passed; captured fixture.
- `OBORO_SHOP_LIVE_CATALOG=1 pnpm --filter @oboro/shop test`: 22 passed, 1 key-only test skipped.
- `pnpm -r test`: 66 passed (21 shop, 1 shop route, 43 SDK, 1 MCP), 5 live tests skipped.
- `pnpm -r typecheck`: passed.
- `pnpm -r build`: passed.

## Captured real catalog

`airtel-india` was in stock. Airtel India talktime packages and USD prices returned by the CLI: ₹10 → $0.11, ₹120 → $1.31, ₹500 → $5.48, ₹1000 → $10.97, ₹5000 → $54.86. Prices can change; the shop looks up the catalog before guardrail checks.

## Blocked

`BITREFILL_API_KEY` is not set, so live REST `ping` and `balance` were skipped. Real invoice creation and delivery were not attempted. Those require the key, an operator decision to set `OBORO_BITREFILL_LIVE_BUY=1`, a funded Bitrefill balance, and a paid x402 request. The route is ready for Claude to mount in `seller.ts` with `express.json()` and a `ShopLedger` using the same path as the approval CLI (`OBORO_SHOP_LEDGER` or `.oboro/shop.json`).
