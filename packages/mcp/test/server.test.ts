import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server.js';
describe('MCP tool registration', () => {
  it('lists the three Oboro tools', async () => {
    const server = createMcpServer();
    const client = new Client({ name: 'oboro-test', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    expect(listed.tools.map(t => t.name).sort()).toEqual(['oboro_budget', 'oboro_fetch', 'oboro_status']);
    await client.close();
    await server.close();
  });
});
