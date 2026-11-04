# Oboro MCP tools

The server exposes `oboro_fetch`, `oboro_budget`, `oboro_status`, and four shop tools: `oboro_shop_search`, `oboro_shop_product`, `oboro_shop_buy`, and `oboro_shop_receipt`. Shop buys use real Bitrefill event credits held by the operator. A shielded testnet ZEC payment authorises each buy, subject to the configured per-request and daily caps. Redemption values are masked in MCP results.

Build the workspace, then add this Claude Desktop server entry. Replace `<abs>` with the absolute path to this repository and supply the environment variables in your local configuration. Never put wallet seeds or spending keys in the configuration.

```json
{
  "mcpServers": {
    "oboro": {
      "command": "node",
      "args": ["<abs>/packages/mcp/dist/index.js"],
      "env": {
        "OBORO_SELLER_NYM_ADDRESS": "<OBORO_SELLER_NYM_ADDRESS>",
        "OBORO_BUYER_WALLET_DIR": "<OBORO_BUYER_WALLET_DIR>",
        "OBORO_TUNNEL_URL": "<OBORO_TUNNEL_URL>",
        "OBORO_MAX_PER_REQUEST_ZATS": "<OBORO_MAX_PER_REQUEST_ZATS>",
        "OBORO_DAILY_CAP_ZATS": "<OBORO_DAILY_CAP_ZATS>",
        "OBORO_SPEND_FILE": "<OBORO_SPEND_FILE>"
      }
    }
  }
}
```

The tunnel must be running and the buyer wallet must be funded on Zcash testnet. A buy can remain `needs_approval`; the operator must approve it before the receipt can be delivered. `oboro_shop_buy` polls a `processing` receipt for up to five minutes.
