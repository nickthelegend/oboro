# Oboro TypeScript build result

## Files

- Workspace: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `.env.example`, `.gitignore`.
- SDK: `packages/sdk/src/{agent,errors,index,nym,paywall,protocol,storage,verifier,zingo}.ts`, package config, and four Vitest files.
- MCP: `packages/mcp/src/{index,server}.ts`, package config, and MCP tool-listing test.
- Agents: `apps/agents/src/{buyer,env,seller}.ts`, `apps/agents/scripts/{setup-seller-viewkey.ts,demo.sh,live-sdk.sh}`, package config.
- Documentation: `TESTING.md` and this file.
- Ignored local setup: `.env`, `.oboro/seller.ufvk`, `.oboro/seller-view/zingo-wallet.dat`, paywall ledger and agent spend state. The viewing-key files are mode 600. No key material is in this report.

## Commands

| Command | Result |
| --- | --- |
| `pnpm install --store-dir .pnpm-store` | Passed |
| `pnpm -r test` | Passed: 34 SDK pure tests, 1 MCP test; 2 live tests skipped |
| `pnpm -r build` | Passed: SDK, MCP, agents |
| `pnpm -r typecheck` | Passed: SDK, MCP, agents |
| `OBORO_LIVE=1 pnpm --filter @oboro/agents setup:seller` | Passed: seller view-only wallet created from UFVK in ignored mode-600 files |
| `OBORO_LIVE=1 bash apps/agents/scripts/live-sdk.sh` | Passed: both real wallet read tests, 36 SDK tests total |
| `bash -n apps/agents/scripts/demo.sh apps/agents/scripts/live-sdk.sh` | Passed |
| `OBORO_LIVE=1 bash apps/agents/scripts/demo.sh` | One paid script run: tip sent; initial settlement blocked by zingo online timeout, then recovered using the same payment header over Nym |
| Existing-payment Nym retry and one fees-only `createAgent.fetch` | Both returned 200 with `X-PAYMENT-RESPONSE`; fees purchase made one additional 3,000-zat send |

## Live evidence

| Resource | Price | Txid | Seller confirmation height | Outcome |
| --- | ---: | --- | ---: | --- |
| `/v1/intel/tip` | 2,000 zats | `a9bf5c18c117ce18fc48677dd5d409261d6cc243ac0a43254dfcaebfceedd3d7` | 4,581,123 | Settled over Nym; HTTP 200 with seller view-wallet height 4,581,146 |
| `/v1/intel/fees` | 3,000 zats | `a2ea9e368d8dad312500153aa0a167bd30e04d82045b709b11d9c83e01045a96` | 4,581,154 | Settled over Nym; HTTP 200 with computed ZIP 317 fee table |

- The agent spend state records **5,000 zatoshis** for the two content payments. Network transaction fees are separate. Both ledger entries are `settled` and `viaMixnet: true`; each txid was redeemed once.
- Buyer confirmed balance in the final real offline read: **1,409,998 zatoshis**. The earlier read before wallet updates was 1,209,998 zatoshis; the balance difference is not attributed to Oboro payments.
- The historical seller test receipt `656d03c9760ad158584cc2552cdb1d3d5c349ea0e766bcd5231485760dcdaa66` was found by `ZingoViewVerifier.find()` in the recently scanned view wallet: 128,000 zatoshis, Ironwood, block 4,548,940.
- After the run, the seller and tunnel HTTP ports were closed, and `/tmp/oboro-zingo.lock` was free.

## Limitations

- Zingo's online `info --waitsync` did not return within five minutes on two initial view-wallet test attempts and during the tip demo. The wallet did save confirmed chain data. The verifier now uses a recently saved wallet snapshot for notes with at least three confirmations, and the same tip payment was settled on a later Nym retry without sending again.
- Cache recency currently uses the view wallet file's modification time; offline zingo operations can also refresh that time. A durable last-online-scan marker would be needed before treating this as production-grade freshness evidence.
- The buyer's full `--once` loop did not complete in one uninterrupted process because the tip demo encountered that online timeout. The tip and fees endpoints were each paid and settled over Nym in the recovery sequence; a clean one-shot autonomous run remains unverified.
