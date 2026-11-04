import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createAgent, required, ZingoWallet } from 'oboro';

type ShopReply = Record<string, unknown>;
const shopUrl = (path: string) => `nym://${required('OBORO_SELLER_NYM_ADDRESS')}${path}`;
const toolResult = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError });
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Redemption codes have cash value. Apply the same masking rule as @oboro/shop.
export function maskRedemption(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (typeof value !== 'string') return [key, '[redacted]'];
    return [key, value.length <= 4 ? '*'.repeat(value.length) : `${value.slice(0, 2)}${'*'.repeat(Math.min(12, value.length - 4))}${value.slice(-2)}`];
  }));
}

async function shopReply(response: Response): Promise<ShopReply> {
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Shop returned an invalid JSON object');
  return body as ShopReply;
}

function purchaseResult(statusCode: number, body: ShopReply) {
  const { status, invoice_id, order_id, product, value, usd, receipt_id, approval_id } = body;
  return toolResult({ status: status ?? statusCode, invoice_id, order_id, product, value, usd, receipt_id, approval_id, redemption: maskRedemption(body.redemption), error: body.error, code: body.code }, statusCode >= 400);
}

function configuredAgent() {
  const recipient = required('OBORO_SELLER_NYM_ADDRESS');
  return createAgent({
    tunnelUrl: process.env.OBORO_TUNNEL_URL ?? 'http://127.0.0.1:7410',
    wallet: new ZingoWallet({ dataDir: required('OBORO_BUYER_WALLET_DIR') }),
    policy: { maxPerRequestZats: Number(process.env.OBORO_MAX_PER_REQUEST_ZATS ?? 50_000), dailyCapZats: Number(process.env.OBORO_DAILY_CAP_ZATS ?? 300_000), allowRecipients: [recipient] },
    spendFile: process.env.OBORO_SPEND_FILE
  });
}
export function createMcpServer() {
  const server = new McpServer({ name: '@oboro/mcp', version: '0.1.0' });
  server.registerTool('oboro_fetch', { description: 'Fetch a nym:// resource and pay with shielded testnet ZEC within policy', inputSchema: { url: z.string(), method: z.string().optional(), body: z.string().optional() } }, async ({ url, method, body }) => {
    const response = await configuredAgent().fetch(url, { method: method ?? 'GET', body });
    const text = (await response.text()).slice(0, 8192);
    let txid: string | undefined;
    try { txid = (JSON.parse(Buffer.from(response.headers.get('x-payment-response') ?? '', 'base64').toString()) as {txid?: string}).txid; } catch { /* unpaid response */ }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: response.status, body: text, txid, mixMs: Number(response.headers.get('x-oboro-mix-ms')) || undefined }) }] };
  });
  server.registerTool('oboro_budget', { description: 'Show spent today and payment caps', inputSchema: {} }, async () => {
    const agent = configuredAgent();
    return { content: [{ type: 'text' as const, text: JSON.stringify({ spentTodayZats: await agent.spentToday(), maxPerRequestZats: agent.policy.maxPerRequestZats, dailyCapZats: agent.policy.dailyCapZats }) }] };
  });
  server.registerTool('oboro_status', { description: 'Show local Oboro tunnel status', inputSchema: {} }, async () => {
    const url = `${(process.env.OBORO_TUNNEL_URL ?? 'http://127.0.0.1:7410').replace(/\/$/, '')}/status`;
    const response = await fetch(url);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: response.status, body: (await response.text()).slice(0, 8192) }) }] };
  });
  server.registerTool('oboro_shop_search', { description: 'Search real Bitrefill products through Tsuki over Nym. Purchases use the operator’s real event credits; a shielded ZEC payment authorises them and spend caps apply.', inputSchema: { query: z.string().min(1) } }, async ({ query }) => {
    const response = await configuredAgent().fetch(shopUrl(`/v1/shop/search?q=${encodeURIComponent(query)}`));
    return toolResult({ status: response.status, ...await shopReply(response) }, !response.ok);
  });
  server.registerTool('oboro_shop_product', { description: 'Show a real Bitrefill product, its package values and USD prices over Nym. Purchases use the operator’s real event credits; a shielded ZEC payment authorises them and spend caps apply.', inputSchema: { product_id: z.string().min(1) } }, async ({ product_id }) => {
    const response = await configuredAgent().fetch(shopUrl(`/v1/shop/product/${encodeURIComponent(product_id)}`));
    return toolResult({ status: response.status, ...await shopReply(response) }, !response.ok);
  });
  server.registerTool('oboro_shop_receipt', { description: 'Check a real Bitrefill purchase receipt over Nym. Purchases use the operator’s real event credits; a shielded ZEC payment authorises them and spend caps apply. Redemption codes are masked.', inputSchema: { receipt_id: z.string().regex(/^[a-f0-9]{48}$/) } }, async ({ receipt_id }) => {
    const response = await configuredAgent().fetch(shopUrl(`/v1/shop/receipt/${receipt_id}`));
    return purchaseResult(response.status, await shopReply(response));
  });
  server.registerTool('oboro_shop_buy', { description: 'Buy a real Bitrefill product using the operator’s real event credits. The agent’s shielded testnet ZEC payment authorises the purchase; per-request and daily spend caps apply. Redemption codes are masked in this tool result.', inputSchema: { product_id: z.string().min(1), value: z.union([z.string().min(1), z.number().positive()]), phone_number: z.string().optional() } }, async ({ product_id, value, phone_number }) => {
    const agent = configuredAgent();
    const response = await agent.fetch(shopUrl('/v1/shop/buy'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id, value, ...(phone_number ? { phone_number } : {}) }) });
    let body = await shopReply(response);
    let statusCode = response.status;
    if (statusCode === 202 && body.status === 'processing') {
      const receiptId = body.receipt_id;
      if (typeof receiptId !== 'string' || !/^[a-f0-9]{48}$/.test(receiptId)) throw new Error('Shop processing response has no valid receipt_id');
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await pause(Math.min(3_000, Math.max(0, deadline - Date.now())));
        const receipt = await agent.fetch(shopUrl(`/v1/shop/receipt/${receiptId}`));
        statusCode = receipt.status;
        body = await shopReply(receipt);
        if (statusCode !== 202 || body.status !== 'processing') break;
      }
      if (statusCode === 202 && body.status === 'processing') return toolResult({ status: 'processing', receipt_id: receiptId, error: 'Receipt still processing after five minutes' }, true);
    }
    return purchaseResult(statusCode, body);
  });
  return server;
}
