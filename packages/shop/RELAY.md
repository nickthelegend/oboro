# Gift-card relay API

The relay sits beside the legacy `/v1/shop/*` routes. All card calls use the seller's Nym address. The buyer's wallet policy checks the dynamic x402 challenge before paying.

| Route | Purpose |
| --- | --- |
| `GET /v1/cards/catalog` | Live ZEC/USD rate, Bitrefill float, relay limits, available denominations and required setup. |
| `POST /v1/cards/quote` | Body `{product_id,value}`; returns a ten-minute quote with the exact USD cost and zats rounded up to 100. |
| `POST /v1/cards/buy` | Body `{quote_id,seal_to?,refund_to?}`; x402 price is bound to the quote. Returns delivered card or 202 buying receipt. |
| `GET /v1/cards/receipt/:receipt_id?seal_to=...` | Poll delivery. The in-memory redemption is returned once, sealed if `seal_to` is present. |
| `GET /oboro/relay` | Public masked sales, today's total, float, rate, and privacy fields. |

`seal_to` is a base64url raw 32-byte X25519 public key. The response uses ephemeral X25519, HKDF-SHA256 with salt `epk || recipientPk` and info `oboro-card-v1`, then AES-256-GCM. The SDK generates a one-time key, opens the result locally, and its `cards(relayNymAddress)` handle offers `catalog`, `quote`, `buy`, and `receipt`.

Configure `BITREFILL_API_KEY`, `OBORO_BITREFILL_LIVE_BUY=1`, and the existing seller wallet and Nym gateway settings. Optional: `OBORO_RELAY_CATALOG`, `OBORO_RELAY_MAX_USD_PER_SALE` (6), `OBORO_RELAY_MAX_USD_PER_DAY` (9), and `OBORO_RELAY_LEDGER` (`.oboro/relay.json`). A Bitrefill balance of 874 means $8.74. No invoice is created without the live-buy flag, a reserved sale, fresh catalog price, and sufficient float.

The ledger stores masked codes and refund addresses. A failed purchase with `refund_to` requests a seller-wallet refund of the paid zats minus 10,000 zats; a failed refund or missing `refund_to` leaves `refund_owed:true` for operator reconciliation. Codes and refund addresses remain in process memory only. Restarting the gateway during an unsettled delivery can require manual recovery from the Bitrefill invoice and masked ledger.
