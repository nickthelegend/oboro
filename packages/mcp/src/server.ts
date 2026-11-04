import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createAgent, required, ZingoWallet } from 'oboro';

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
  return server;
}
