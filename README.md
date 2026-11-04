# Oboro 朧: x402 for AI agents over the Nym mixnet, paid in shielded Zcash

**One line:** Oboro lets one AI agent pay another for an HTTP API in shielded Zcash. Both the request and the payment
cross the Nym mixnet, so the seller gets paid without learning who called, from where, or which wallet paid.

`oboro` (TypeScript SDK) · `oboro-node` (Rust, Nym mixnet transport) · `@oboro/mcp` (MCP tools) · console + landing.
Built at the Zcash Free Society Hack, Mumbai, 4 Nov 2026, in the Privacy track (Theme 3: privacy beyond the transaction).

## Demo

- **Testnet tx (shielded, v6, created by Oboro):** [`4f3bb7a47716b30074dedb8df06ebae9094a08b4847ce41a75f0c588253ba3a1`](https://testnet.zcashexplorer.app/transactions/4f3bb7a47716b30074dedb8df06ebae9094a08b4847ce41a75f0c588253ba3a1)
  (block 4,581,179). Kumo paid Tsuki 2,000 zats for `/v1/intel/tip`, pressed from the console. The request,
  the 402 and the paid retry all crossed the Nym mixnet. Zexplorer link: <https://zexplorer.app/testnet/tx/4f3bb7a47716b30074dedb8df06ebae9094a08b4847ce41a75f0c588253ba3a1>
  (at 12:00 IST Zexplorer's testnet index was stuck at block 4,505,665, so use the zcashexplorer link until it catches up).
- Earlier paid runs: [`a9bf5c18…`](https://testnet.zcashexplorer.app/transactions/a9bf5c18c117ce18fc48677dd5d409261d6cc243ac0a43254dfcaebfceedd3d7) (tip, block 4,581,123) and
  [`a2ea9e36…`](https://testnet.zcashexplorer.app/transactions/a2ea9e368d8dad312500153aa0a167bd30e04d82045b709b11d9c83e01045a96) (fees, block 4,581,154).
- Video: _link_
- Console and landing run locally (the agents, the Nym clients and the wallets live on the operator's machine): see Run it.

### Live run, as the console recorded it (4 Nov 2026, IST)

| Time | Step |
|---|---|
| 12:03:22 | Kumo sends `GET nym://Tsuki/v1/intel/tip` into its tunnel |
| 12:03:26 | `402 Payment Required`, 2,000 zats, back over the mixnet (3.5 s) |
| 12:03:26 | Spend policy allows it (≤ 50,000 per call, daily cap 300,000) |
| 12:04:17 | Payment broadcast over Nym, txid `4f3bb7a4…` |
| 12:04:27 | Tsuki answers `402 payment_pending` while its view-only wallet syncs |
| 12:09:26 | Verified with the viewing key (memo, amount, nonce), `200` with Tsuki's data (height 4,581,182) |

Tsuki's gate logged each request as `sender: SURB reply tag only (no IP, no Nym address)`.

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
Kumo (buyer agent)                                                      Tsuki (seller agent)
  oboro SDK ──HTTP──▶ oboro-node tunnel ══ Nym mixnet: entry gw → 3 mix layers → gw ══▶ oboro-node gate ──HTTP──▶ Express + paywall
      │                (127.0.0.1:7410)          Sphinx packets, cover traffic              (no public port)      (127.0.0.1:7420)
      │                                          replies on single-use reply blocks (SURBs)                             │
      └── zingo-cli quicksend ══ Nym (zingo's nym-proxy) ══▶ lightwalletd ──▶ Zcash testnet ◀── viewing-key wallet ──┘
```

1. **The call crosses the mixnet.** `kumo.fetch('nym://<Tsuki's Nym address>/v1/intel/tip')` goes to the local
   `oboro-node tunnel`. It frames the HTTP request (length-prefixed JSON) on a `nym-sdk` `MixnetStream` to Tsuki's Nym
   address. Tsuki's `oboro-node gate` accepts the stream and forwards it to Tsuki's Express app on localhost. Tsuki
   has no public port at all.
2. **402 on a reply-only path.** Tsuki answers `402` with an x402 v1 challenge (`scheme: zcash-shielded`,
   `network: zcash-testnet`, price in zatoshis, a shielded unified address and a one-time nonce). The reply travels back
   on single-use reply blocks, so the gate never learns Kumo's Nym address, let alone an IP.
3. **Policy, then a shielded payment.** Kumo's SDK checks the spend policy (per-call cap, daily cap, allowed
   recipients) **before** any transaction exists, then pays exactly the price with memo `oboro:<nonce>` using
   zingo-cli, which broadcasts over Nym.
4. **Verified with a viewing key.** Kumo retries with `X-PAYMENT` (txid + nonce). Tsuki's server holds only a
   **view-only** wallet. It finds the note, checks the memo, amount and confirmations, redeems the nonce and the txid
   once, and answers `200` with `X-PAYMENT-RESPONSE`. While the note is unmined it answers `402 payment_pending`.

## Run it

Needs: macOS or Linux, Node 26 + pnpm 10, Rust 1.94, and zingo-cli built from
[zingolib](https://github.com/zingolabs/zingolib) with its `nym` feature (`nym-proxy` beside the binary). Two funded
testnet wallets (Ironwood): one for Kumo, one for Tsuki. Any Zcash mentor or [Fauzec](https://fauzec.com) gives TAZ.

```bash
pnpm install
cargo build --release --manifest-path crates/Cargo.toml      # oboro-node (~4 min)
cp .env.example .env                                         # fill in the wallet dirs and zingo-cli path
OBORO_SELLER_VIEW_BIRTHDAY=<recent height> pnpm --filter @oboro/agents setup:seller   # view-only wallet for Tsuki
scripts/up.sh                                                # Tsuki, Tsuki's gate, Kumo's tunnel, console
open http://127.0.0.1:7430/#/console                         # press a Buy button
scripts/down.sh
```

Headless instead of the console: `pnpm --filter @oboro/agents buyer --once <Tsuki's Nym address>`.
MCP: point any MCP client at `node packages/mcp/dist/index.js` with `OBORO_TUNNEL_URL`, `OBORO_SELLER_NYM_ADDRESS` and
`OBORO_BUYER_WALLET_DIR` set; tools `oboro_fetch`, `oboro_budget`, `oboro_status`.

Tests: `pnpm -r test` (34 SDK + 1 MCP unit tests), `cargo test --manifest-path crates/Cargo.toml` (6 unit tests),
live mixnet round trip `cargo test --manifest-path crates/Cargo.toml --test live_roundtrip -- --ignored` (real Nym
mainnet mixnet, no mocks). Details and the recorded results: [TESTING.md](TESTING.md), [crates/RESULT.md](crates/RESULT.md).

## Repo layout

| Path | What |
|---|---|
| `crates/oboro-node` | Rust. `gate` (serve a local HTTP app at a Nym address), `tunnel` (local port → any Nym address), `probe` |
| `packages/sdk` (`oboro`) | TypeScript. `createAgent` (x402 client + spend policy), `createPaywall` (x402 server), zingo wallet + view-key verifier |
| `packages/mcp` (`@oboro/mcp`) | MCP server: `oboro_fetch`, `oboro_budget`, `oboro_status` |
| `apps/agents` | Tsuki (seller) and Kumo (buyer), setup and demo scripts |
| `apps/dashboard` | Landing page, live console and the console server |
| `scripts/up.sh`, `down.sh` | Start and stop the whole stack |

## Design decisions

- **Streams, not the deprecated TCP proxy.** `oboro-node` uses nym-sdk's `MixnetStream` (AsyncRead/AsyncWrite),
  one stream per HTTP request, with 4-byte length-prefixed JSON frames, because streams have no close/EOF.
- **A ready handshake.** nym-sdk 1.21.4 silently drops data that arrives for a stream the receiver hasn't accepted
  yet, so the gate sends a ready frame first. Before the fix, 2 of 3 live runs stalled; after it, 3 of 3 passed.
- **The seller has no public port.** Tsuki's Express app listens on 127.0.0.1; its only door is its Nym address.
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
   - **Tsuki (the seller)** sees what was requested, the amount it was paid and the payment's memo nonce. It does not
     see an IP, a Nym address or a payer address.
   - **The Nym network.** The entry gateway sees Kumo's IP but not the destination. Mix nodes see neither end. Tsuki's
     gateway sees Tsuki's gate but not the sender.
   - **The light-wallet server** (`testnet.zec.rocks`) sees each wallet's IP and sync timing, because wallet *sync* is
     a direct connection. Transaction *broadcast* goes over Nym (zingo Mixnet Mode). Sync over the mixnet is
     impractically slow today; Nym's dVPN is the fix (see Next 30 days).
   - **Oboro's state files** hold nonces, txids and the paywall ledger locally. Nothing else is stored.
3. **Who users must trust.** The seller's operator, to serve what was paid for. The Nym network's mixing, against
   global timing analysis: low traffic makes timing correlation easier. Zingo and lightwalletd, for wallet correctness.
4. **What we'd fix next.** Move wallet sync onto Nym's 2-hop dVPN. Add Nym cover traffic and timing jitter between the
   payment and the retry. Add multi-seller discovery without a directory that learns who looks up whom.

## Technologies used

| Tech | Version | Used for |
|---|---|---|
| Nym mixnet, [nym-sdk](https://crates.io/crates/nym-sdk) | 1.21.4 (Nym mainnet) | `MixnetClient` streams, SURB replies |
| Zcash testnet (NU7, Ironwood, v6 tx) | `testnet.zec.rocks` lightwalletd | shielded payments |
| [zingolib](https://github.com/zingolabs/zingolib) zingo-cli + nym-proxy | commit `0a5cb69` (Zingo CLI 0.1.1, `nym` feature) | wallets, view-only verification, send over Nym |
| [x402](https://x402.org) | v1 wire format | 402 challenge, `X-PAYMENT`, `X-PAYMENT-RESPONSE` |
| Rust, tokio, axum, reqwest (rustls) | 1.94.0, 1.54.1, 0.8.9, 0.12 | oboro-node |
| Node.js, pnpm, TypeScript, Vitest | 26.5.0, 10.29.2, 5.9, 3.2 | SDK, MCP, agents, tests |
| Express | 5.1 | Tsuki's paywalled API, console server |
| Model Context Protocol SDK | 1.22 | `@oboro/mcp` |
| React, Vite | 19.2, 7.2 | landing + console |
| Urbanist, Space Mono (Google Fonts) | | UI type |
| ChatGPT image generation | 4 Nov 2026 | brand art (`assets/generated/`) |

## Next 30 days

1. **Faster settlement:** keep one interactive zingo session per wallet, so verification reads a continuously synced
   wallet instead of starting a new CLI, mixnet bootstrap and sweep on every check (in progress today).
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
