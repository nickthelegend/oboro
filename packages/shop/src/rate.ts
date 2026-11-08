import { ShopError } from './shop.js';

export type ZecRate = { usd: number; source: 'kraken' | 'coingecko'; at: string };
let cached: { value: ZecRate; until: number } | undefined;
export async function zecUsd(fetcher: typeof fetch = fetch): Promise<ZecRate> {
  if (cached && cached.until > Date.now()) return cached.value;
  const sources = [
    { source: 'kraken' as const, url: 'https://api.kraken.com/0/public/Ticker?pair=ZECUSD', read: (x: any) => Number(x?.result?.XZECZUSD?.c?.[0]) },
    { source: 'coingecko' as const, url: 'https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd', read: (x: any) => Number(x?.zcash?.usd) },
  ];
  for (const item of sources) {
    try {
      const response = await fetcher(item.url, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) continue;
      const usd = item.read(await response.json());
      if (!Number.isFinite(usd) || usd <= 0) continue;
      const value = { usd, source: item.source, at: new Date().toISOString() };
      cached = { value, until: Date.now() + 60_000 }; return value;
    } catch { /* try fallback */ }
  }
  throw new ShopError('rate_unavailable', 'Live ZEC/USD rate unavailable', 503);
}
export function usdToZats(usd: number, rate: number): number {
  if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(rate) || rate <= 0) throw new ShopError('rate_unavailable', 'Invalid ZEC/USD price', 503);
  const zats = Math.ceil(usd / rate * 1e8 / 100) * 100;
  if (!Number.isSafeInteger(zats)) throw new ShopError('rate_unavailable', 'ZEC price exceeds safe integer range', 503);
  return zats;
}
