import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cardResult, createMcpServer, maskRedemption } from '../src/server.js';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
describe('MCP tool registration', () => {
  it('lists shop and card tools with input schemas', async () => {
    const server = createMcpServer();
    const client = new Client({ name: 'oboro-test', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    expect(listed.tools.map(t => t.name).sort()).toEqual(['oboro_budget', 'oboro_fetch', 'oboro_shop_buy', 'oboro_shop_product', 'oboro_shop_receipt', 'oboro_shop_search', 'oboro_status', 'oboro_wallet_budget', 'oboro_cards_catalog', 'oboro_cards_quote', 'oboro_cards_buy', 'oboro_cards_receipt'].sort());
    expect(listed.tools.every(t => t.inputSchema.type === 'object')).toBe(true);
    const properties = (name: string) => listed.tools.find(t => t.name === name)?.inputSchema.properties ?? {};
    expect(Object.keys(properties('oboro_fetch')).sort()).toEqual(['body', 'method', 'url']);
    expect(Object.keys(properties('oboro_budget'))).toEqual([]);
    expect(Object.keys(properties('oboro_wallet_budget'))).toEqual([]);
    expect(Object.keys(properties('oboro_status'))).toEqual([]);
    expect(Object.keys(properties('oboro_shop_search'))).toEqual(['query']);
    expect(Object.keys(properties('oboro_shop_product'))).toEqual(['product_id']);
    expect(Object.keys(properties('oboro_shop_receipt'))).toEqual(['receipt_id']);
    expect(Object.keys(properties('oboro_shop_buy')).sort()).toEqual(['phone_number', 'product_id', 'value']);
    expect(listed.tools.find(t => t.name === 'oboro_shop_buy')?.inputSchema.required).toEqual(['product_id', 'value']);
    await client.close();
    await server.close();
  });
});

describe('redemption masking', () => {
  it('retains only two characters at each end and redacts nonstrings', () => {
    expect(maskRedemption({ code: 'ABCDEFGHIJ', pin: '440404', nested: { secret: 'hidden' } })).toEqual({ code: 'AB******IJ', pin: '******', nested: '[redacted]' });
    expect(maskRedemption(undefined)).toBeUndefined();
  });
  it('writes a code privately and returns only a mask and path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oboro-cards-'));
    try {
      const result = await cardResult({ status: 'delivered', receipt_id: 'a'.repeat(48), code: { code: 'ABSECRET12CD' } }, join(dir, 'cards'));
      expect(JSON.stringify(result)).not.toContain('ABSECRET12CD');
      expect(result).toMatchObject({ code_masked: { code: 'AB********CD' } });
      const path = String((result as { code_path: string }).code_path);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ code: 'ABSECRET12CD' });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, 'cards'))).mode & 0o777).toBe(0o700);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
