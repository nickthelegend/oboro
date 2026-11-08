import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BitrefillClient, indiaDay, maskPhoneTail, maskRedemption, ShopError } from './shop.js';
import { usdToZats, zecUsd, type ZecRate } from './rate.js';

export type RelayConfig = { catalog: { product_id: string; values: (number | string)[] }[]; maxUsdPerSale: number; maxUsdPerDay: number };
export type RelayQuote = { quote_id: string; product_id: string; name: string; kind: 'card' | 'recharge'; value: string; amount?: number; currency: string; usd: number; zec_usd: number; rate_source: ZecRate['source']; zats: number; created_at: string; expires_at: string };
export type RelaySale = { receipt_id: string; quote_id: string; txid: string; product_id: string; name: string; kind: 'card' | 'recharge'; value: string; amount?: number; currency: string; usd: number; zats: number; zec_usd: number; status: 'paid' | 'buying' | 'delivered' | 'failed' | 'refunded'; invoice_id?: string; order_ids: string[]; code_masked?: Record<string, unknown>; phone_masked?: string; refund_to_masked?: string; refund_txid?: string; refund_owed?: boolean; created_at: string; delivered_at?: string };
type State = { quotes: Record<string, RelayQuote>; sales: Record<string, RelaySale> };
const defaultCatalog = [{ product_id: 'blink-it-india', values: [250, 500] }, { product_id: 'swiggy-money-india', values: [50, 100, 250] }, { product_id: 'reliance-jio-india-bundles', values: ['2GB/Day 5G Plan – 14 Days', '1.5GB/Day – 22 Days', '1.5GB/Day – 28 Days', '2GB/Day 5G Plan – 36 Days'] }];
export function relayConfigFromEnv(env = process.env): RelayConfig {
  try {
    const catalog = env.OBORO_RELAY_CATALOG ? JSON.parse(env.OBORO_RELAY_CATALOG) : defaultCatalog;
    const maxUsdPerSale = Number(env.OBORO_RELAY_MAX_USD_PER_SALE ?? 6);
    const maxUsdPerDay = Number(env.OBORO_RELAY_MAX_USD_PER_DAY ?? 9);
    if (!Array.isArray(catalog) || !catalog.every(x => x && /^[a-z0-9-]{1,100}$/.test(x.product_id) && Array.isArray(x.values) && x.values.length && x.values.every((v: unknown) => /^(?:\d+(?:\.\d+)?|[\w .+/–-]{1,80})$/.test(String(v)))) || ![maxUsdPerSale, maxUsdPerDay].every(n => Number.isFinite(n) && n > 0)) throw Error();
    return { catalog, maxUsdPerSale, maxUsdPerDay };
  } catch { throw new ShopError('invalid_relay_config', 'Invalid relay configuration', 500); }
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class RelayLedger {
  constructor(readonly file = process.env.OBORO_RELAY_LEDGER ?? '.oboro/relay.json') {}
  private async read(): Promise<State> { try { return JSON.parse(await readFile(this.file, 'utf8')) as State; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { quotes: {}, sales: {} }; throw e; } }
  private async write(s: State) { await mkdir(dirname(this.file), { recursive: true }); const tmp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`; const handle = await open(tmp, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(s)); await handle.sync(); } finally { await handle.close(); } await rename(tmp, this.file); }
  private async lock<T>(fn: (s: State) => T | Promise<T>): Promise<T> { const lock = `${this.file}.lock`; await mkdir(dirname(this.file), { recursive: true }); for (let i = 0; i < 100; i++) { try { await mkdir(lock); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; if (i === 99) throw new ShopError('ledger_busy', 'Relay ledger is busy', 503); await wait(25); } } try { const s = await this.read(); const result = await fn(s); await this.write(s); return result; } finally { await rm(lock, { recursive: true, force: true }); } }
  async addQuote(quote: Omit<RelayQuote, 'quote_id'>) { return this.lock(s => { const q = { ...quote, quote_id: randomBytes(24).toString('hex') }; s.quotes[q.quote_id] = q; return q; }); }
  async getQuote(id: string) { return (await this.read()).quotes[id]; }
  async reserve(quote: RelayQuote, txid: string, refundTo?: string, maxUsdPerDay?: number, phoneNumber?: string) { if (!/^[a-f0-9]{64}$/i.test(txid)) throw new ShopError('invalid_txid', 'Invalid transaction ID', 400); return this.lock(s => { if (s.sales[txid]) throw new ShopError('duplicate_txid', 'Transaction already used', 409); if (!s.quotes[quote.quote_id]) throw new ShopError('quote_expired', 'Quote expired', 410); const day = indiaDay(new Date()); const committed = Object.values(s.sales).filter(x => indiaDay(new Date(x.created_at)) === day && ['paid', 'buying', 'delivered'].includes(x.status)).reduce((n, x) => n + x.usd, 0); const overLimit = maxUsdPerDay !== undefined && committed + quote.usd > maxUsdPerDay; const sale: RelaySale = { receipt_id: randomBytes(24).toString('hex'), quote_id: quote.quote_id, txid, product_id: quote.product_id, name: quote.name, kind: quote.kind, value: quote.value, amount: quote.amount, currency: quote.currency, usd: quote.usd, zats: quote.zats, zec_usd: quote.zec_usd, status: 'paid', order_ids: [], phone_masked: quote.kind === 'recharge' && phoneNumber ? maskPhoneTail(phoneNumber) : undefined, refund_to_masked: refundTo ? `${refundTo.slice(0, 8)}…${refundTo.slice(-6)}` : undefined, created_at: new Date().toISOString() }; s.sales[txid] = sale; return { ...sale, overLimit }; }); }
  async update(txid: string, patch: Partial<Omit<RelaySale, 'txid' | 'receipt_id' | 'code_masked' | 'refund_to_masked'>>) { return this.lock(s => { const sale = s.sales[txid]; if (!sale) throw new ShopError('receipt_unknown', 'Sale not found', 404); Object.assign(sale, patch); return sale; }); }
  async delivered(txid: string, orderId: string, redemption?: Record<string, unknown>) { return this.lock(s => { const sale = s.sales[txid]; if (!sale) throw new ShopError('receipt_unknown', 'Sale not found', 404); sale.status = 'delivered'; sale.order_ids = [...new Set([...sale.order_ids, orderId])]; sale.code_masked = maskRedemption(redemption); sale.delivered_at = new Date().toISOString(); return sale; }); }
  async byReceipt(id: string) { return Object.values((await this.read()).sales).find(s => s.receipt_id === id); }
  async byTxid(txid: string) { return (await this.read()).sales[txid]; }
  async list() { return Object.values((await this.read()).sales); }
  async today(now = new Date()) { const day = indiaDay(now); const sales = (await this.list()).filter(s => indiaDay(new Date(s.created_at)) === day && ['buying', 'delivered'].includes(s.status)); return Math.round(sales.reduce((n, s) => n + s.usd, 0) * 100) / 100; }
}
export class Relay {
  constructor(readonly client = new BitrefillClient(), readonly ledger = new RelayLedger(), readonly config = relayConfigFromEnv(), readonly rate: () => Promise<ZecRate> = zecUsd) {}
  async quote(productId: string, value: string | number): Promise<RelayQuote> {
    const entry = this.config.catalog.find(x => x.product_id === productId);
    if (!entry) throw new ShopError('not_in_catalog', 'Product not in relay catalog', 409);
    if (!entry.values.some(v => String(v) === String(value))) throw new ShopError('value_not_available', 'Value not in relay catalog', 409);
    if (!this.client.hasKey()) throw new ShopError('setup_required', 'Setup required: BITREFILL_API_KEY', 503);
    const product = await this.client.getProduct(productId, true);
    if (!product.in_stock) throw new ShopError('value_not_available', 'Product out of stock', 409);
    const pkg = product.packages.find(p => p.value === String(value));
    if (!pkg) throw new ShopError('value_not_available', 'Package unavailable', 409);
    if (pkg.usd > this.config.maxUsdPerSale) throw new ShopError('over_sale_limit', 'Package exceeds sale limit', 409);
    if (await this.ledger.today() + pkg.usd > this.config.maxUsdPerDay) throw new ShopError('over_daily_limit', 'Relay daily limit reached', 409);
    if (pkg.usd > await this.client.floatUsd()) throw new ShopError('float_empty', 'Relay float is insufficient', 409);
    const rate = await this.rate(); const now = Date.now();
    return this.ledger.addQuote({ product_id: productId, name: product.name, kind: product.recipient_type === 'phone_number' ? 'recharge' : 'card', value: String(value), amount: pkg.amount, currency: pkg.currency || product.currency, usd: pkg.usd, zec_usd: rate.usd, rate_source: rate.source, zats: usdToZats(pkg.usd, rate.usd), created_at: new Date(now).toISOString(), expires_at: new Date(now + 600_000).toISOString() });
  }
}
