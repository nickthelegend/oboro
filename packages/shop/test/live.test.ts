import { expect, it } from 'vitest';
import { BitrefillClient } from '../src/shop.js';

it.skipIf(process.env.OBORO_SHOP_LIVE_CATALOG !== '1')('live no-key CLI search and Airtel details (opt in with OBORO_SHOP_LIVE_CATALOG=1)', async () => {
  const client = new BitrefillClient('');
  const products = await client.searchProducts('airtel', 'IN');
  expect(products.some(p => p.id === 'airtel-india' && p.in_stock)).toBe(true);
  const product = await client.getProduct('airtel-india');
  expect(product.packages.some(p => p.value === '10' && p.usd > 0)).toBe(true);
  console.log(JSON.stringify({ product: product.id, packages: product.packages.map(p => ({ value: p.value, usd: p.usd })) }));
}, 60_000);

it.skipIf(!process.env.BITREFILL_API_KEY)('live key ping and balance (Setup required: BITREFILL_API_KEY)', async () => {
  const client = new BitrefillClient();
  expect(await client.ping()).toBeDefined();
  expect(await client.balance()).toBeDefined();
}, 30_000);
