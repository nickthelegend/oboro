# @oboro/shop

Tsuki's guarded Bitrefill shop. A confirmed shielded Zcash testnet x402 payment **authorises** one purchase; Bitrefill charges the operator's event-credit balance in real money. TAZ does not pay Bitrefill.

## Setup

Set `BITREFILL_API_KEY` only in the ignored `.env` and set `OBORO_BITREFILL_LIVE_BUY=1` only when ready to permit guarded real purchases. Without a key, `GET /v1/shop/search` and `GET /v1/shop/product/:id` use `@bitrefill/cli@0.3.0` to browse the live catalog. A missing key returns `setup_required: Setup required: BITREFILL_API_KEY` on an otherwise allowed purchase.

`OBORO_SHOP_ALLOW` can hold JSON such as:

```json
{"allow":[{"product_id":"airtel-india","values":[10]}],"maxUsdPerPurchase":0.5,"maxUsdPerDay":1.5,"maxPurchasesPerDay":3}
```

Those values are also the safe defaults. Prices are loaded fresh from Bitrefill's product packages before invoice creation, never accepted from a buyer request; free browsing uses a 10-minute catalog cache. A price, daily spend, or count above a cap creates a `needs_approval` record and makes no Bitrefill purchase. The operator approves out of band with `pnpm --filter @oboro/agents shop:approve <approval_id>`; the buyer then polls the receipt token. The server must stay running until approval because the full phone number is held only in memory. A restart keeps the masked approval record but loses the number; the operator must resolve that case manually. The ledger defaults to `.oboro/shop.json` and uses atomic mode-600 writes. The seller integration should set `OBORO_SHOP_LEDGER` to the same path for the route and CLI.

The buy route reserves each authorising txid before creating an invoice. A crash after Bitrefill accepts an invoice may leave the purchase unresolved, but a replay cannot create a second invoice. Invoice `complete` is not fulfillment; the worker waits for order `delivered`. Failed, refunded, blocked, denied, and payment errors are reported without an automatic rebuy. An expired invoice can be recreated once.

`redemption_info` is returned only in the paid buy response or the receipt endpoint using the random receipt token issued to that buyer. It is never written to disk. The ledger contains only masked code and phone values. A receipt requested after the in-memory result has been consumed shows only masked data.

## Verify

`pnpm -r test`, `pnpm -r typecheck`, `pnpm -r build`. Run `OBORO_SHOP_LIVE_CATALOG=1 pnpm --filter @oboro/shop test` for a no-key catalog check. With `BITREFILL_API_KEY` set, the live test also calls `ping` and `balance`; it never creates an invoice.
