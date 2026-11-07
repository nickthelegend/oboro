import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, maskRedemption } from '../src/server.js';
describe('MCP tool registration', () => {
  it('lists all eight Oboro tools with input schemas', async () => {
    const server = createMcpServer();
    const client = new Client({ name: 'oboro-test', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    expect(listed.tools.map(t => t.name).sort()).toEqual(['oboro_budget', 'oboro_fetch', 'oboro_shop_buy', 'oboro_shop_product', 'oboro_shop_receipt', 'oboro_shop_search', 'oboro_status', 'oboro_wallet_budget'].sort());
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
});
