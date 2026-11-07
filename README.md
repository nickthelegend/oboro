# Oboro 朧: private payments infrastructure

**A wallet SDK, a merchant gateway and commerce connectors that pay in shielded Zcash over the Nym mixnet, plus a
wallet app where a person keeps the budget.**

Oboro is infrastructure for private payments by software. A developer adds one SDK and any app, agent or store can pay
for APIs over x402 and buy real goods, like phone recharges and grocery credit, in shielded Zcash. Every request, 402
challenge and payment crosses the Nym mixnet, so the merchant never sees the payer's IP, Nym address or wallet. Before
each spend the wallet checks its policy (payee, per-payment cap, daily cap); anything over a limit waits for a person in
the wallet app. Merchants accept payments with one gateway that verifies with a viewing key and has no public port.
Real-world fulfilment runs through commerce connectors; Bitrefill is the first.

Agents are not the product: they are clients of the wallet. `examples/` has three of them, built only on the SDK.

| Layer | What it is | Where |
|---|---|---|
| **Wallet SDK** | `createWallet()`: x402 `fetch` over Nym, spend policy, budget, `merchant(addr)` to search, buy and get receipts | `packages/sdk` (`oboro`) |
| **Merchant gateway** | `createGateway()`: x402 paywall that verifies with a viewing key; the reference gateway server has no public port | `packages/sdk`, `apps/gateway` |
| **Commerce connectors** | `CommerceConnector` interface; `bitrefillConnector()` for recharges, gift cards and top-ups, with caps and approval | `packages/shop` (`@oboro/shop`) |
| **MCP server** | Any MCP host (Claude, Cursor…) gets the wallet as eight tools | `packages/mcp` (`@oboro/mcp`) |
| **Nym transport** | `tunnel` (payer side) and `gate` (merchant side) carry HTTP through the mixnet | `crates/oboro-node` (Rust, nym-sdk 1.22.3) |
| **Wallet app** | Balance, budget, approvals, activity and a "who saw what" receipt, for the person whose money it is | `apps/wallet` |

| Example (built on the SDK) | What it shows | Where |
|---|---|---|
| **Shopping agent** | An LLM with five tools, each one SDK call (`shop.rules/search/product/buy/receipt`); over a limit it asks you. Try it in the wallet app at `#/examples`, or run `cli.ts` in a terminal. | `examples/shopping-agent` |
| **Paid-API agent** | A short script that pays an x402 API per call and decides whether the next call is worth it | `examples/paid-api-agent` |
| **MCP client** | Claude Desktop config for `@oboro/mcp` | `examples/mcp-client` |

```ts
import { createWallet, ZingoWallet } from 'oboro';

const wallet = createWallet({
  tunnelUrl: 'http://127.0.0.1:7410',                          // local oboro-node tunnel into Nym
  wallet: new ZingoWallet({ dataDir: process.env.OBORO_BUYER_WALLET_DIR! }),
  policy: { maxPerRequestZats: 50_000, dailyCapZats: 300_000, allowRecipients: [MERCHANT] },
});

await wallet.fetch(`nym://${MERCHANT}/v1/intel/tip`);            // pays an x402 API, privately
const shop = wallet.merchant(MERCHANT);                         // a merchant's commerce routes, over Nym
await shop.buy({ product_id: 'swiggy-money-india', value: '50' }); // buys a real Swiggy Money card
```

Built at the Zcash Free Society Hack, Mumbai, 4 Nov 2026; restructured into infrastructure + examples on 7 and 8 Nov
(see the commit history). In the recorded runs below, "the agent" is the example shopping agent holding an Oboro wallet
and "the gateway" is a merchant running the Oboro gateway with the Bitrefill connector.

## Tracks: entered in Both

| Track | What counts for it |
|---|---|
| **Privacy** (Theme 3: privacy beyond the transaction) | x402 over the Nym mixnet: request, 402, payment broadcast and paid retry never touch the seller from an IP. Testnet txids below; privacy and trust note below. |
| **Agentic Commerce** (Bitrefill, **Lane 5: private by default**) | The loop: an agent's shielded payment over Nym → The gateway's guardrails → Bitrefill REST v2 invoice paid from store credits → polled to **delivered**. Invoice ID, touchpoints and guardrails below. |

**The loop (Lane 5):** an agent with no Bitrefill account, no card and no exposed IP, asks the gateway's shop over Nym
→ **guarantee:** the agent's own spend policy, then a shielded ZEC payment that the gateway verifies with a viewing key; the gateway's
allow-list, per-purchase and daily caps, one purchase per txid → **Bitrefill:** search, quote, invoice, pay from
balance → **ending:** the order is delivered and the code lands in the gateway's Bitrefill account; the buyer's copy comes back
only in its paid response, masked everywhere else.

Honest scope: Bitrefill doesn't take ZEC and has no testnet, so the shielded *testnet* payment **authorises** the
purchase and the gateway pays Bitrefill from its store credits (real money, small). We don't claim ZEC paid for the card.

## Demo

### Infrastructure film (8 Nov 2026, filmed live)

Film (2:34; link added when uploaded). Opens on the landing hero, then the layers, the SDK, the examples, and one live
run of the example shopping agent; sped-up stretches are badged.
- **Over-limit purchase by the example agent:** *"Buy me ₹250 of Swiggy credit for groceries."* ($2.77, over the
  merchant's $1 purchase limit.) The agent asks first; after *"Yes, go ahead."* the wallet pays
  [`7258e99d…5fa3`](https://testnet.zcashexplorer.app/transactions/7258e99d305bf711c10da75721f266f449d142426367bb645416661d41d25fa3)
  (5,000 zats, shielded, over Nym), the gateway verifies it with its viewing key and parks the purchase, a person
  approves it in the wallet app (22:33:32 UTC), and the Bitrefill connector delivers invoice
  **`b43ae428-8fa3-45ad-a26c-150eaf0b3631`** (order `6aefa7364af62a4d94fa94d4`).

### Wallet film (7 Nov 2026, filmed live)

Film: `videos/oboro-wallet-film.mp4` (2:47; link added when uploaded). Every demo step ran live on camera, and sped-up stretches are badged.
- **x402 API call from the agent wallet**, over Nym: 2,000 zats, shielded tx
  [`9efd8b83…609e`](https://testnet.zcashexplorer.app/transactions/9efd8b83008c6bba12fd8c4267b3efa681c7a7e22f052fe15d65187de312609e)
  (block 4,593,599), verified by the merchant gateway's viewing key and served.
- **Over-budget purchase from the wallet app:** *"Buy me ₹250 of Swiggy credit for groceries."* ($2.77, over the $1 cap.)
  The agent asks first, pays ([`ac7eb817…ccf5`](https://testnet.zcashexplorer.app/transactions/ac7eb8176f102d9f938840e0dd6c1f0cb8e441faedfd941aceb5f9b26287ccf5)),
  the purchase waits for a human, the human approves, and the Bitrefill connector delivers invoice
  **`0d69acd0-70eb-4e8c-a8c8-279bac72b4ea`**.

### Earlier runs (4 Nov 2026)


- **Testnet tx (shielded, v6, created by Oboro):** [`4f3bb7a47716b30074dedb8df06ebae9094a08b4847ce41a75f0c588253ba3a1`](https://testnet.zcashexplorer.app/transactions/4f3bb7a47716b30074dedb8df06ebae9094a08b4847ce41a75f0c588253ba3a1)
  (block 4,581,179). The agent paid the gateway 2,000 zats for `/v1/intel/tip`, pressed from the console. The request,
  the 402 and the paid retry all crossed the Nym mixnet. Zexplorer link: <https://zexplorer.app/testnet/tx/4f3bb7a47716b30074dedb8df06ebae9094a08b4847ce41a75f0c588253ba3a1>
  (at 12:00 IST Zexplorer's testnet index was stuck at block 4,505,665, so use the zcashexplorer link until it catches up).
- Earlier paid runs: [`a9bf5c18…`](https://testnet.zcashexplorer.app/transactions/a9bf5c18c117ce18fc48677dd5d409261d6cc243ac0a43254dfcaebfceedd3d7) (tip, block 4,581,123) and
  [`a2ea9e36…`](https://testnet.zcashexplorer.app/transactions/a2ea9e368d8dad312500153aa0a167bd30e04d82045b709b11d9c83e01045a96) (fees, block 4,581,154).
- Video (1:59, every demo step live; sped-up stretches are badged): https://drive.google.com/file/d/1s3gzBqAsQmjiZa-PXmar27n-cBwqReiP/view
- Console and landing run locally (The agents, the Nym clients and the wallets live on the operator's machine): see Run it.

### Live run, as the console recorded it (4 Nov 2026, IST)

| Time | Step |
|---|---|
| 12:03:22 | The agent sends `GET nym://the gateway/v1/intel/tip` into its tunnel |
| 12:03:26 | `402 Payment Required`, 2,000 zats, back over the mixnet (3.5 s) |
| 12:03:26 | Spend policy allows it (≤ 50,000 per call, daily cap 300,000) |
| 12:04:17 | Payment broadcast over Nym, txid `4f3bb7a4…` |
| 12:04:27 | The gateway answers `402 payment_pending` while its view-only wallet syncs |
| 12:09:26 | Verified with the viewing key (memo, amount, nonce), `200` with the gateway's data (height 4,581,182) |

the gateway's gate logged each request as `sender: SURB reply tag only (no IP, no Nym address)`.

## Agentic Commerce: the Bitrefill purchases

**Talk to the agent.** The example agent page (`#/examples`; it was the Shop page on 4 Nov) is a chat with the example
shopping agent, an LLM (Claude Haiku 5.5 via OpenRouter, `examples/shopping-agent/agent.ts`) whose only tools are Oboro's: `shop_rules`, `search_products`, `get_product`, `buy` and
`check_purchase`, each reaching the gateway over Nym. Recorded live at 16:27 IST:
- *"What can you buy me for under a dollar?"* the agent reads the gateway's rules and four live Bitrefill prices through the
  mixnet (2.0 to 4.3 s each) and lists Swiggy, Flipkart, Google Play and Uber at ₹50.
- *"Get me ₹50 of Google Play credit."* the agent buys it on its own: shielded payment
  [`ef3a3c23…1322`](https://testnet.zcashexplorer.app/transactions/ef3a3c239cc3326b051ce27c0f89136a9c67d04673c7a742a40ab6dfc26f1322),
  Bitrefill invoice **`a2fed34d-06ea-40cb-8670-ff53fa60f843`** (order `6aeb11497073473b2edcfb50`), delivered 16:34:44.
- *"Also buy me a ₹500 Flipkart card."* Refused **before any payment**: $5.61 is over the gateway's $1 cap, so only a human
  could approve it.

- *"Buy me ₹250 of Swiggy credit for groceries."* ($2.75, over the cap.) the agent explains that the merchant's operator must
  approve it. Told *"Yes, go ahead and send it for approval"*, it pays (shielded txid
  [`80c31d54…983e`](https://testnet.zcashexplorer.app/transactions/80c31d5442e576601d6c3f0cd1aed04c3f9824a25dfe50778f6e53b2eec5983e)).
  The gateway parks the purchase at 17:03:01, a human presses **Approve** on the merchant's side at 17:03:21, and Bitrefill delivers:
  invoice **`c0d4eacc-92e9-4d04-a3e0-7413d053d7fc`** (order `6aeb17fdb8b44b12deb0c060`). The agent has no tool that
  approves.
- *"Instamart doesn't deliver here. Get me a ₹250 Blinkit card instead."* ($2.78; Bitrefill's smallest Blinkit card.)
  Over the cap again, so the agent asks first, then pays (shielded txid
  [`97ae0934…36e8`](https://testnet.zcashexplorer.app/transactions/97ae093437adcc2cbe07198c85cd09632569ff7f7471a1d638a06c534e2036e8)).
  The gateway parks it at 20:01:21 and buys nothing until the operator approves; then Bitrefill delivers: invoice
  **`ab17c7fc-f23e-4c5e-b3f0-76f12f3ae6cd`** (order `6aeb42972380844701a9e3ab`). Blinkit was added to the gateway's
  allow-list at ₹250 only.

**The first purchase** (button-driven, before the chat existed):

- **Real purchase invoice ID:** `6df85b58-7e1d-40a1-975e-e136f9b9e5ed` (order `6aeb0c33273062b3038ebfa5`):
  Swiggy Money India ₹50, $0.55, paid from the gateway's Bitrefill store credits, order **delivered** at 16:13:02 IST,
  4 Nov 2026. The agent pressed it; nothing was bought by hand.
- **Authorised by** shielded testnet payment
  [`51fe1cefa34634af9c8b68f34c76ae7730aafd5c6996cc220a15ca3fcfb0f68e`](https://testnet.zcashexplorer.app/transactions/51fe1cefa34634af9c8b68f34c76ae7730aafd5c6996cc220a15ca3fcfb0f68e)
  (5,000 zats, the agent → The gateway, broadcast over Nym).
| Time (IST) | Step, as the Shop page recorded it |
|---|---|
| 16:07:01 | The agent browses the gateway's catalog over Nym (`GET nym://the gateway/v1/shop/search?q=swiggy`) |
| 16:07:07 | Live Bitrefill quote over Nym: ₹50 = $0.55 |
| 16:07:10 | `POST /v1/shop/buy` → `402`; the agent's policy allows 5,000 zats |
| 16:07:49 | Shielded payment broadcast over Nym, txid `51fe1cef…` |
| 16:13:02 | The gateway's viewing key sees the note; txid reserved; Bitrefill invoice created and paid from balance; order `delivered` |

Two earlier attempts paid but bought nothing, and that's the guarantee working. The first (`55d033b5…`) was seen
only after its 15-minute challenge expired, and the paywall refused it. That's how we found and fixed a real bug:
the deadline is now for *submitting* a payment, not for verifying it. The second (`2dcaefb8…`) was cut off when we
restarted the gateway mid-poll. Neither reached Bitrefill.

### Bitrefill touchpoints: built vs reused

We built a **REST v2 worker** (`packages/shop`): `GET /products/search`, `GET /products/{id}` for the USD price that
the caps use, `POST /invoices` with `payment_method: "balance"` and `auto_pay: true`, then `GET /invoices/{id}` and
`GET /orders/{id}` until the order is `delivered`; `complete` alone is never treated as done. It handles 429s
(exponential backoff with jitter, 5 tries), an expired quote (one fresh invoice, re-checked against the caps), `failed`,
`refunded`, `blocked`, `denied`, `payment_error` and out-of-stock, and caches the catalog for 10 minutes. The **CLI**
(`@bitrefill/cli` 0.3.0) is reused as the no-key catalog path, so the shop can browse before an account exists.
An **MCP interface** sits on top: `@oboro/mcp` exposes `oboro_shop_search`, `oboro_shop_product`, `oboro_shop_buy` and
`oboro_shop_receipt`, so Claude or any MCP client shops through Oboro's guardrails over Nym, never directly. Reused:
Bitrefill's catalog, invoices and delivery, unchanged.

### Guardrails

- **Most the agent can spend here:** $1.00 per purchase, $3.00 and 3 purchases per day (Asia/Kolkata day), only
  allow-listed products and values (`swiggy-money-india` ₹50, `flipkart-india` ₹50, `airtel-india` ₹10). Set in
  `OBORO_SHOP_ALLOW`; prices always come from Bitrefill, never from the request.
- **Above that:** nothing is bought. The purchase is parked as `needs_approval`. A human approves it on the merchant's side,
  either with the Shop page's operator **Approve** button (local-only `POST /api/operator/approve`) or with
  `pnpm --filter @oboro/gateway shop:approve <approval_id>`. No tool the agent can call approves anything. (Live:
  invoice `c0d4eacc…`, above.)
- **Replays:** one purchase per authorising Zcash txid, reserved in a mode-600 ledger **before** `POST /invoices`, so a
  crash or a replayed payment can't buy twice.
- **The agent's side:** its own spend policy (≤ 50,000 zats per call, 300,000 per day, the gateway only) runs before it pays.
- **Codes are cash:** redemption values are never logged or stored unmasked; the ledger, console and MCP results show
  the first 2 and last 2 characters only.

## Also on Zcash mainnet (outside the hackathon scope)

The submission and the film are testnet, as the rules ask. The same code also runs on mainnet behind an explicit
switch (`OBORO_CHAIN=mainnet`; testnet stays the default and mainnet is refused unless that variable is set). On
4 Nov 2026, from the agent's own mainnet wallet funded with 0.01 ZEC, over the same Nym mixnet:
- **x402 API call:** the agent paid the gateway 2,000 zats, shielded, verified with the gateway's viewing key:
  [`5d6048d6…dd8c2`](https://blockchair.com/zcash/transaction/5d6048d636fb870f8ad16f8665240c9d3a4c6696373546fa7741d920655dd8c2),
  block 3,541,707.
- **Bitrefill purchase from chat:** *"Get me ₹50 of Swiggy credit"*: the agent paid 5,000 zats
  ([`51e91b35…0c69`](https://blockchair.com/zcash/transaction/51e91b3520333a842b44c4e7bcc6ec85d3956e3fe3017e634b0aa3ab79d80c69),
  block 3,541,714) and Bitrefill delivered invoice **`01c3fbf9-db34-4b70-869e-348078a70054`** (order `6aeb4e71390889e2b66a5af7`).
- **Over the cap, human-approved:** *"Get me a ₹250 Blinkit card for groceries."* ($2.77.) the agent explains it needs the gateway's
  operator, is told to go ahead, and pays
  ([`5a03194b…7d0f`](https://blockchair.com/zcash/transaction/5a03194be2813838d1ef8d47811ad0dd8f5ec1384d800edcac50dceb16657d0f),
  block 3,541,772). The gateway parks it; after the operator approves, Bitrefill delivers invoice
  **`6ec705e7-5ab5-4c42-8f13-ac7483fa1b39`** (order `6aeb5d5f5376aed24165d2d6`).

- **Phone recharge from chat, no code to redeem:** *"Recharge my Jio number with the 6GB 7-day data pack."* ($0.77, over
  the day's cap, so human-approved.) the agent pays ([`5f3e980f…fdb8`](https://blockchair.com/zcash/transaction/5f3e980fc650befbb01336589457c7266d0c9508e6c335809f4286fcc46efdb8)),
  the gateway parks it, the operator approves, and Bitrefill tops up the phone directly: invoice **`9665190c-99ef-41b3-8641-73ac57bb9bce`**
  (order `6aeb6f64f0106a061b7ec21e`). The number is stored masked (`••3648`).

A second recorded x402 call, after a UI label fix: [`a43d037e…7aab`](https://blockchair.com/zcash/transaction/a43d037e644f5820b193968a1d8a1124f0aac43214e324cbd0da15cbf6d77aab), block 3,541,778.

On the explorer each shows only the 0.0001 ZEC fee leaving the shielded pool: no sender, receiver or amount.
Mainnet film (1:52, all live, sped-up stretches badged; API call, Swiggy, Blinkit, Jio recharge and the Jio SMS): https://drive.google.com/file/d/1jSkJzlmZg2nRI3frlHKefkCJE2J5jwJq/view
To run it: put the mainnet wallet dirs and state paths in an env file outside the repo and start with
`OBORO_ENV_OVERLAY=<that file> scripts/up.sh` (see `MAINNET_MODE_RESULT.md` for the variables).

## Who it's for and the problem

AI agents are starting to pay for the APIs they call ([x402](https://x402.org): `402 Payment Required` → pay → retry
with `X-PAYMENT`). On a public chain each of those payments is public. Shielded Zcash fixes the payment, and
shielded x402 already exists (we checked: Frontier-Compute/zcash-402, nhestrompia/shielded-x402, zchan, and our own
Zecathon entry Kage).

The second leak is still open. The HTTP request that triggers a shielded payment comes from an IP address at a moment
in time, to a server. That server, or anyone watching the network, can put the request next to the payment window and
link the agent to it. The money is hidden, but the caller isn't.

Oboro moves the request itself into the mixnet:

| Leak | x402 on a public chain | Shielded x402 | **Oboro** |
|---|---|---|---|
| Who paid whom, amount (on chain) | public | hidden | hidden |
| Agent's IP, at the seller | seen | seen | **never reaches it** |
| Seller's IP, at the agent | seen | seen | **no public endpoint** |
| Payment broadcast | from your IP | from your IP | **over Nym** (zingo Mixnet Mode) |

## How it works

```
Agent wallet (oboro SDK)                                                      Merchant gateway
  oboro SDK ──HTTP──▶ oboro-node tunnel ══ Nym mixnet: entry gw → 3 mix layers → gw ══▶ oboro-node gate ──HTTP──▶ Express + paywall
      │                (127.0.0.1:7410)          Sphinx packets, cover traffic              (no public port)      (127.0.0.1:7420)
      │                                          replies on single-use reply blocks (SURBs)                             │
      └── zingo-cli quicksend ══ Nym (zingo's nym-proxy) ══▶ lightwalletd ──▶ Zcash testnet ◀── viewing-key wallet ──┘
```

1. **The call crosses the mixnet.** `wallet.fetch('nym://<the gateway's Nym address>/v1/intel/tip')` goes to the local
   `oboro-node tunnel`. It frames the HTTP request (length-prefixed JSON) on a `nym-sdk` `MixnetStream` to the gateway's Nym
   address. The gateway's `oboro-node gate` accepts the stream and forwards it to the gateway's Express app on localhost. The gateway
   has no public port at all.
2. **402 on a reply-only path.** the gateway answers `402` with an x402 v1 challenge (`scheme: zcash-shielded`,
   `network: zcash-testnet`, price in zatoshis, a shielded unified address and a one-time nonce). The reply travels back
   on single-use reply blocks, so the gate never learns the agent's Nym address, let alone an IP.
3. **Policy, then a shielded payment.** the agent's SDK checks the spend policy (per-call cap, daily cap, allowed
   recipients) **before** any transaction exists, then pays exactly the price with memo `oboro:<nonce>` using
   zingo-cli, which broadcasts over Nym.
4. **Verified with a viewing key.** the agent retries with `X-PAYMENT` (txid + nonce). The gateway's server holds only a
   **view-only** wallet. It finds the note, checks the memo, amount and confirmations, redeems the nonce and the txid
   once, and answers `200` with `X-PAYMENT-RESPONSE`. While the note is unmined it answers `402 payment_pending`.

## Run it

Needs: macOS or Linux, Node 26 + pnpm 10, Rust 1.94, and zingo-cli built from
[zingolib](https://github.com/zingolabs/zingolib) with its `nym` feature (`nym-proxy` beside the binary). Two funded
testnet wallets (Ironwood): one for the agent, one for the gateway. Any Zcash mentor or [Fauzec](https://fauzec.com) gives TAZ.

```bash
pnpm install
cargo build --release --manifest-path crates/Cargo.toml      # oboro-node (~4 min)
cp .env.example .env                                         # fill in the wallet dirs and zingo-cli path
OBORO_SELLER_VIEW_BIRTHDAY=<recent height> pnpm --filter @oboro/gateway setup:gateway  # view-only wallet for the gateway
scripts/up.sh                                                # gateway, its Nym gate, the wallet's Nym tunnel, wallet app
open http://127.0.0.1:7430/#/wallet                          # the wallet app; #/examples for the example agent
scripts/down.sh
```

Examples from a terminal: `pnpm --filter @oboro/example-paid-api-agent start -- --once <the gateway's Nym address>` and
`pnpm --filter @oboro/example-shopping-agent start` (a chat in the terminal, using `wallet.merchant()` directly).
MCP: see [examples/mcp-client](examples/mcp-client) for a Claude Desktop config (env var names only).

Tests: `pnpm -r test` (57 SDK, 22 shop, 2 MCP, 1 gateway, 5 example-agent unit tests), `cargo test --manifest-path crates/Cargo.toml` (6 unit tests),
live mixnet round trip `cargo test --manifest-path crates/Cargo.toml --test live_roundtrip -- --ignored` (real Nym
mainnet mixnet, no mocks). Details and the recorded results: [TESTING.md](TESTING.md), [crates/RESULT.md](crates/RESULT.md).

## Repo layout

| Path | What |
|---|---|
| `crates/oboro-node` | Rust. `gate` (serve a local HTTP app at a Nym address), `tunnel` (local port → any Nym address), `probe` |
| `packages/sdk` (`oboro`) | TypeScript. `createWallet` (x402 client, spend policy, budget, merchant client), `createGateway` (x402 server), zingo wallet + view-key verifier |
| `packages/shop` (`@oboro/shop`) | `CommerceConnector` interface and `bitrefillConnector()`: Bitrefill REST v2 worker, CLI catalog, guardrails, txid-deduped ledger |
| `packages/mcp` (`@oboro/mcp`) | MCP server: `oboro_fetch`, `oboro_budget`, `oboro_status`, `oboro_shop_search`, `_product`, `_buy`, `_receipt` |
| `apps/gateway` | Reference merchant gateway: x402 routes, the Bitrefill shop routes, setup and `shop:approve` scripts |
| `apps/wallet` | Wallet app (balance, budget, approvals, activity), example agent page, developer console, landing, and its server |
| `examples/shopping-agent` | Example: LLM shopping agent on `wallet.merchant()` (`agent.ts`, `cli.ts`, 5 tests) |
| `examples/paid-api-agent` | Example: a script that pays an x402 API per call |
| `examples/mcp-client` | Example: Claude Desktop config for `@oboro/mcp` |
| `scripts/up.sh`, `down.sh`, `restart.sh` | Start, stop and restart the stack |

## Design decisions

- **Streams, not the deprecated TCP proxy.** `oboro-node` uses nym-sdk's `MixnetStream` (AsyncRead/AsyncWrite),
  one stream per HTTP request, with 4-byte length-prefixed JSON frames, because streams have no close/EOF.
- **A ready handshake.** nym-sdk 1.21.4 silently dropped data that arrived for a stream the receiver hadn't accepted
  yet, so the gate sends a ready frame first. Before the fix, 2 of 3 live runs stalled; after it, 3 of 3 passed.
  We now run nym-sdk 1.22.3 (`nym-binaries-v2026.21-hanoi`), which buffers early data for about 5 s and adds
  `OpenAck`; we keep the handshake because mixnet delay can exceed that buffer, and there is still no Close frame.
- **The seller has no public port.** the gateway's Express app listens on 127.0.0.1; its only door is its Nym address.
  Replies ride SURBs, so the gate never learns the caller's Nym address.
- **Policy before payment.** The agent checks per-call cap, daily cap, recipient allow-list and challenge expiry
  before it builds a transaction. A refusal throws `policy_refused` with `paid: false`.
- **Viewing key on the server.** The paywall verifies with a view-only zingo wallet: memo `oboro:<nonce>`, amount and
  confirmations. Each nonce and each txid is redeemed once.
- **x402 v1 wire format** with a `zcash-shielded` scheme on `zcash-testnet`, so existing x402 tooling can read the challenge.
- **Separate lockfiles.** The Nym stack and Zcash wallet crypto can't share one Cargo resolution, so the node
  depends on no Zcash crate and the wallet is zingo-cli behind a process boundary.

## Privacy and trust note

1. **What stays private.** Sender, receiver and amount are shielded on-chain, and the memo (`oboro:<nonce>`) is
   encrypted. The HTTP request and response travel inside the Nym mixnet: the seller's server never sees the buyer's
   IP or Nym address, and the buyer never learns the seller's IP.
2. **What the app reveals, to whom.**
   - **The merchant gateway (seller)** sees what was requested, the amount it was paid and the payment's memo nonce. It does not
     see an IP, a Nym address or a payer address.
   - **The Nym network.** The entry gateway sees the agent's IP but not the destination. Mix nodes see neither end. The gateway's
     gateway sees the gateway's gate but not the sender.
   - **The light-wallet server** (`testnet.zec.rocks`) sees each wallet's IP and sync timing, because wallet *sync* is
     a direct connection. Transaction *broadcast* goes over Nym (zingo Mixnet Mode). Sync over the mixnet is
     impractically slow today; Nym's dVPN is the fix (see Next 30 days).
   - **Oboro's state files** hold nonces, txids, the paywall ledger and a masked purchase ledger. Codes are masked
     to their first and last two characters, and values of 8 characters or fewer are hidden entirely. Gift cards need
     no phone or email.
   - **Bitrefill** sees the gateway's account, the product and its price. It never sees the agent, the agent's wallet or the agent's IP.
   - **The AI model provider** (OpenRouter, then Anthropic) sees the chat with the agent, product names, prices and rule
     checks. It never sees a wallet key, a Bitrefill key, a code or the payment. A local model removes this trust.
3. **Who users must trust.** The seller's operator, to serve what was paid for, and the merchant's operator to fulfil
   purchases from its Bitrefill balance. The model provider, with the chat. The Nym network's mixing, against
   global timing analysis: low traffic makes timing correlation easier. Zingo and lightwalletd, for wallet correctness.
4. **What we'd fix next.** Move wallet sync onto Nym's 2-hop dVPN. Add Nym cover traffic and timing jitter between the
   payment and the retry. Add multi-seller discovery without a directory that learns who looks up whom.

## Technologies used

| Tech | Version | Used for |
|---|---|---|
| Nym mixnet, [nym-sdk](https://github.com/nymtech/nym/tree/nym-binaries-v2026.21-hanoi/sdk/rust/nym-sdk) | 1.22.3, git tag `nym-binaries-v2026.21-hanoi` (Nym mainnet) | `MixnetClient` streams, SURB replies |
| Zcash testnet (NU7, Ironwood, v6 tx) | `testnet.zec.rocks` lightwalletd | shielded payments |
| [zingolib](https://github.com/zingolabs/zingolib) zingo-cli + nym-proxy | commit `0a5cb69` (Zingo CLI 0.1.1, `nym` feature) | wallets, view-only verification, send over Nym |
| [x402](https://x402.org) | v1 wire format | 402 challenge, `X-PAYMENT`, `X-PAYMENT-RESPONSE` |
| Rust, tokio, axum, reqwest (rustls) | 1.94.0, 1.54.1, 0.8.9, 0.12 | oboro-node |
| Node.js, pnpm, TypeScript, Vitest | 26.5.0, 10.29.2, 5.9, 3.2 | SDK, MCP, agents, tests |
| Express | 5.1 | The gateway's paywalled API, console server |
| Model Context Protocol SDK | 1.22 | `@oboro/mcp` (8 tools) |
| Bitrefill REST v2 + `@bitrefill/cli` | v2 · 0.3.0 | `@oboro/shop` worker, no-key catalog |
| OpenRouter → Claude Haiku 5.5 | `anthropic/claude-haiku-5.5` | The agent's chat agent (tool calling) |
| React, Vite | 19.2, 7.2 | landing + console |
| Urbanist, Space Mono (Google Fonts) | | UI type |
| ChatGPT image generation | 4 Nov 2026 | brand art (`assets/generated/`) |

## Next 30 days

1. **Faster settlement:** `ZingoSession` (built today, `OBORO_ZINGO_SESSION=1`) keeps one interactive zingo-cli per
   wallet: the second call takes 1 ms instead of a fresh spawn. It isn't the default yet. In the live shop run its
   sync loop never reported 100% while new blocks kept arriving, so checks queued behind it. The demo uses the
   spawn-per-call verifier (settled in about 5 minutes). Next: read `messages` without waiting on the sync loop.
2. **Sync over Nym's dVPN** (needs the NYM credentials Nym hands out at the event), so the light-wallet server stops
   seeing the agents' IPs during sync too.
3. **Publish** `oboro` and `@oboro/mcp` to npm and `oboro-node` to crates.io; open an issue on nym-sdk about data
   frames being dropped before `accept()`, with our repro and handshake.
4. **Seller discovery without a tracker:** a signed service manifest published at the seller's Nym address.
5. **Cover traffic and timing jitter** between the payment and the paid retry, against timing correlation at low volume.

## Feedback

See [FEEDBACK.md](FEEDBACK.md).

## License

MIT, Copyright (c) 2026 Nivesh Gajengi
