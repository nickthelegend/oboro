import { expect, it } from 'vitest';
import { BitrefillClient, bitrefillConnector, type CommerceConnector } from '../src/index.js';

it('adapts a Bitrefill client to the commerce connector interface', async () => {
  const paths: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    paths.push(String(input));
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const connector: CommerceConnector = bitrefillConnector(new BitrefillClient('test-key', 'https://bitrefill.invalid/v2', fetcher as typeof fetch));
  expect(connector.name).toBe('bitrefill');
  expect(connector.hasKey()).toBe(true);
  expect(await connector.search('gift card')).toEqual([]);
  expect(paths).toEqual(['https://bitrefill.invalid/v2/products/search?q=gift%20card&country=IN']);
  expect(typeof connector.product).toBe('function');
  expect(typeof connector.buy).toBe('function');
  expect(typeof connector.status).toBe('function');
});
