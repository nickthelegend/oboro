import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BitrefillClient, Relay, RelayLedger, relayConfigFromEnv, usdToZats, zecUsd } from '../src/index.js';

it('parses real Kraken and CoinGecko response shapes and rounds upward', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
  try {
    const kraken = vi.fn(async () => new Response(JSON.stringify({ error: [], result: { XZECZUSD: { c: ['300.50', '1'] } } })));
    expect(await zecUsd(kraken as typeof fetch)).toMatchObject({ usd: 300.5, source: 'kraken' });
    expect(await zecUsd(kraken as typeof fetch)).toMatchObject({ source: 'kraken' }); expect(kraken).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_001);
    const fallback = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('kraken') ? { error: ['unavailable'] } : { zcash: { usd: 301.25 } })));
    expect(await zecUsd(fallback as typeof fetch)).toMatchObject({ usd: 301.25, source: 'coingecko' });
    vi.advanceTimersByTime(60_001);
    await expect(zecUsd((async () => new Response('{}')) as typeof fetch)).rejects.toMatchObject({ code: 'rate_unavailable', httpStatus: 503 });
    expect(usdToZats(3, 300)).toBe(1_000_000);
    expect(usdToZats(3.001, 300)).toBe(1_000_400);
  } finally { vi.useRealTimers(); }
});
it('rejects invalid relay configuration', () => expect(() => relayConfigFromEnv({ OBORO_RELAY_CATALOG: '{bad' })).toThrowError());
it('interprets Bitrefill USD balance as cents and caches for 30 seconds', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ balance: 874, currency: 'USD' })));
  const client = new BitrefillClient('test-key', 'https://example.invalid/v2', fetcher as typeof fetch);
  expect(await client.floatUsd()).toBe(8.74); expect(await client.floatUsd()).toBe(8.74); expect(fetcher).toHaveBeenCalledTimes(1);
  client.invalidateFloat(); expect(await client.floatUsd()).toBe(8.74); expect(fetcher).toHaveBeenCalledTimes(2);
  const wrong = new BitrefillClient('test-key', 'https://example.invalid/v2', (async () => new Response(JSON.stringify({ data: { balance: 874, currency: 'BTC' } }))) as typeof fetch);
  await expect(wrong.floatUsd()).rejects.toMatchObject({ code: 'account_currency_not_usd' });
});
it('quotes catalog values and refuses sale, daily and float limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oboro-relay-'));
  const product = { id: 'blink-it-india', name: 'Blinkit', in_stock: true, currency: 'INR', packages: [{ value: '250', usd: 3, currency: 'INR' }, { value: '500', usd: 6.5, currency: 'INR' }] };
  let float = 8.74;
  const client = { hasKey: () => true, getProduct: async () => product, floatUsd: async () => float } as unknown as BitrefillClient;
  const ledger = new RelayLedger(join(dir, 'relay.json'));
  const relay = new Relay(client, ledger, { catalog: [{ product_id: 'blink-it-india', values: [250, 500] }], maxUsdPerSale: 6, maxUsdPerDay: 9 }, async () => ({ usd: 300, source: 'kraken', at: '' }));
  try {
    await expect(relay.quote('other', 250)).rejects.toMatchObject({ code: 'not_in_catalog' });
    await expect(relay.quote('blink-it-india', 100)).rejects.toMatchObject({ code: 'value_not_available' });
    await expect(relay.quote('blink-it-india', 500)).rejects.toMatchObject({ code: 'over_sale_limit' });
    const q = await relay.quote('blink-it-india', 250); expect(q).toMatchObject({ usd: 3, zats: 1_000_000, rate_source: 'kraken' });
    const sale = await ledger.reserve(q, 'a'.repeat(64)); await ledger.update(sale.txid, { status: 'buying' });
    await expect(ledger.reserve(q, sale.txid)).rejects.toMatchObject({ code: 'duplicate_txid' });
    const low = new Relay(client, ledger, { catalog: relay.config.catalog, maxUsdPerSale: 6, maxUsdPerDay: 5 }, relay.rate);
    await expect(low.quote('blink-it-india', 250)).rejects.toMatchObject({ code: 'over_daily_limit' });
    float = 1; await expect(relay.quote('blink-it-india', 250)).rejects.toMatchObject({ code: 'float_empty' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it.skipIf(process.env.OBORO_LIVE !== '1')('reads real rate and Blinkit price', async () => {
  const client = new BitrefillClient();
  const [rate, product] = await Promise.all([zecUsd(), client.getProduct('blink-it-india', true)]);
  const pkg = product.packages.find(p => p.value === '250');
  expect(pkg).toBeDefined(); expect(usdToZats(pkg!.usd, rate.usd)).toBeGreaterThan(0);
});
