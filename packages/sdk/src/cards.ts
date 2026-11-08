import { openSeal, oneTimeKey, type Sealed } from './seal.js';

export type CardPackage = { value: string; amount?: number; usd: number; zats: number; available: boolean; reason?: string };
export type CardCatalog = { rate: { usd: number; source: string; at: string }; float_usd: number | null; limits: { max_usd_per_sale: number; max_usd_per_day: number; sold_today_usd: number }; products: { product_id: string; name: string; kind: 'card' | 'recharge'; currency: string; in_stock: boolean; packages: CardPackage[] }[]; setup: string[] };
export type CardQuote = { quote_id: string; product_id: string; name: string; kind: 'card' | 'recharge'; value: string; amount?: number; currency: string; usd: number; zec_usd: number; rate_source: string; zats: number; created_at: string; expires_at: string };
export type CardResult = { status: string; receipt_id: string; kind?: 'card' | 'recharge'; phone_masked?: string; amount?: number; txid?: string; invoice_id?: string; order_id?: string; product?: string; value?: string; currency?: string; usd?: number; zats?: number; zec_usd?: number; code?: Record<string, string>; code_masked?: Record<string, string>; refund_owed?: boolean; refund_txid?: string };
type Raw = Omit<CardResult, 'code'> & { sealed?: Sealed; redemption?: Record<string, string> };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export function createCards(fetchPaid: (url: string, init?: RequestInit) => Promise<Response>, relayNymAddress: string) {
  const root = `nym://${relayNymAddress}`;
  const keys = new Map<string, ReturnType<typeof oneTimeKey>>();
  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchPaid(`${root}${path}`, init); const body = await response.json() as T & { error?: string; code?: string };
    if (!response.ok && response.status !== 202) throw new Error(body.error ?? body.code ?? `Relay HTTP ${response.status}`);
    return body;
  }
  function opened(raw: Raw, key?: ReturnType<typeof oneTimeKey>): CardResult {
    const code = raw.sealed && key ? openSeal<Record<string, string>>(raw.sealed, key.privateKey) : raw.redemption;
    const { sealed: _sealed, redemption: _redemption, ...rest } = raw;
    return { ...rest, ...(code ? { code } : {}) };
  }
  const catalog = () => json<CardCatalog>('/v1/cards/catalog');
  const quote = (product_id: string, value: string | number) => json<CardQuote>('/v1/cards/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id, value }) });
  async function receipt(receipt_id: string): Promise<CardResult> {
    const key = keys.get(receipt_id);
    const raw = await json<Raw>(`/v1/cards/receipt/${encodeURIComponent(receipt_id)}${key ? `?seal_to=${encodeURIComponent(key.publicKey)}` : ''}`);
    return opened(raw, key);
  }
  async function buy(quote_id: string, options: { refundTo?: string; phoneNumber?: string } = {}): Promise<CardResult> {
    const key = oneTimeKey();
    const raw = await json<Raw>('/v1/cards/buy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quote_id, seal_to: key.publicKey, ...(options.refundTo ? { refund_to: options.refundTo } : {}), ...(options.phoneNumber !== undefined ? { phone_number: options.phoneNumber } : {}) }) });
    if (raw.receipt_id) keys.set(raw.receipt_id, key);
    if (raw.status !== 'buying') return opened(raw, key);
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) { await pause(5_000); const result = await receipt(raw.receipt_id); if (result.status !== 'buying') return result; }
    return { status: 'buying', receipt_id: raw.receipt_id };
  }
  return { catalog, quote, buy, receipt };
}
