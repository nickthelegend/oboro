import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export class ShopError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 500) { super(message); this.name = 'ShopError'; }
}
export interface Package { value: string; usd: number; currency: string; amount?: number }
export interface Product { id: string; name: string; in_stock: boolean; currency: string; recipient_type: 'phone_number' | 'none'; packages: Package[] }
export interface SearchResult { id: string; name: string; in_stock: boolean; currency: string }
export type Invoice = { id: string; status: string; orders: { id: string; status: string }[] };
export type Order = { id: string; status: string; redemption_info?: Record<string, unknown> };
export type InvoiceInput = { products: { product_id: string; quantity: 1; value?: number; package_id?: string; phone_number?: string }[]; payment_method: 'balance'; auto_pay: true; webhook_url?: string };
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const str = (v: unknown) => typeof v === 'string' ? v : '';
const idOf = (v: Json) => str(v.id ?? v._id ?? v.slug);
const usdOf = (v: Json) => Number(v.usd_price ?? v.price_usd ?? v.payment_price ?? (obj(v.price).usd) ?? NaN);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const INVOICE_PERMIT = Symbol('guardrails_checked');
export const indiaDay = (date: Date) => { const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date); const part = (type: string) => parts.find(p => p.type === type)?.value ?? ''; return `${part('year')}-${part('month')}-${part('day')}`; };
export function backoffMs(attempt: number, random = Math.random()): number { return Math.min(30_000, 500 * 2 ** attempt) + Math.floor(random * 500); }
export function parseSearch(raw: unknown): SearchResult[] {
  // REST v2 search returns `data` as a bare array; the CLI wraps results in { products } or { data }.
  const data = obj(raw); const entries = Array.isArray(raw) ? raw : Array.isArray(data.products) ? data.products : Array.isArray(data.data) ? data.data : [];
  return entries.map((entry: unknown) => { const x = obj(entry); return { id: idOf(x), name: str(x.name), in_stock: x.in_stock !== false, currency: str(x.currency) }; }).filter(x => x.id);
}
export function parseProduct(raw: unknown): Product {
  const x = obj(raw); const list = Array.isArray(x.packages) ? x.packages : [];
  const packages = list.map((item: unknown) => { const p = obj(item); return { value: String(p.value ?? p.package_value ?? ''), usd: usdOf(p), currency: str(p.currency ?? p.package_currency ?? x.currency), ...(typeof p.amount === 'number' && Number.isFinite(p.amount) ? { amount: p.amount } : {}) }; }).filter((p: Package) => p.value && Number.isFinite(p.usd) && p.usd >= 0);
  const id = idOf(x); if (!id) throw new ShopError('invalid_product_response', 'Bitrefill product response lacks an id');
  return { id, name: str(x.name), in_stock: x.in_stock !== false, currency: str(x.currency), recipient_type: x.recipient_type === 'phone_number' ? 'phone_number' : 'none', packages };
}
async function cli(args: string[], timeoutMs = 25_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(npm_config_|pnpm_)/i.test(name) && name !== 'BASE_URL' && name !== 'BITREFILL_API_KEY'));
    const child = spawn('npx', ['--yes', '@bitrefill/cli@0.3.0', '--json', ...args], { env: { ...cleanEnv, npm_config_cache: '/private/tmp/oboro-npm-cache' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 2_000_000) child.kill('SIGTERM'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 200_000) child.kill('SIGTERM'); });
    child.on('error', error => { clearTimeout(timer); reject(new ShopError('catalog_cli_failed', error.message, 503)); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) return reject(new ShopError('catalog_cli_failed', `Bitrefill catalog CLI failed (${code}): ${stderr.slice(0, 300)}`, 503)); try { resolve(JSON.parse(output)); } catch { reject(new ShopError('invalid_catalog_response', 'Bitrefill catalog CLI returned invalid JSON', 503)); } });
  });
}
export class BitrefillClient {
  private cache = new Map<string, { until: number; value: unknown }>();
  constructor(private readonly key = process.env.BITREFILL_API_KEY, private readonly base = 'https://api.bitrefill.com/v2', private readonly fetcher: typeof fetch = fetch) {}
  hasKey() { return !!this.key; }
  private async request(path: string, init?: RequestInit): Promise<unknown> {
    if (!this.key) throw new ShopError('setup_required', 'Setup required: BITREFILL_API_KEY', 503);
    for (let attempt = 0; attempt <= 5; attempt++) {
      let response: Response;
      try { response = await this.fetcher(`${this.base}${path}`, { ...init, headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...init?.headers }, signal: AbortSignal.timeout(12_000) }); }
      catch (error) { throw new ShopError('bitrefill_timeout', error instanceof Error ? error.message : 'Bitrefill request timed out', 504); }
      if (response.status === 429 && attempt < 5) { await delay(backoffMs(attempt)); continue; }
      let body: unknown; try { body = await response.json(); } catch { throw new ShopError('bitrefill_invalid_json', 'Bitrefill returned invalid JSON', 502); }
      if (!response.ok) { const e = obj(body); throw new ShopError(response.status === 429 ? 'bitrefill_rate_limited' : str(e.status) || 'bitrefill_error', `Bitrefill HTTP ${response.status}`, response.status); }
      const data = obj(body).data ?? (path === '/accounts/balance' && obj(body).balance !== undefined ? body : undefined); if (data === undefined) throw new ShopError('bitrefill_invalid_response', 'Bitrefill response lacks data', 502);
      return data;
    }
    throw new ShopError('bitrefill_rate_limited', 'Bitrefill rate limit exhausted', 429);
  }
  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> { const existing = this.cache.get(key); if (existing && existing.until > Date.now()) return existing.value as T; const value = await fn(); this.cache.set(key, { value, until: Date.now() + 600_000 }); return value; }
  ping() { return this.request('/ping'); }
  balance() { return this.request('/accounts/balance'); }
  async floatUsd(): Promise<number> { const cached = this.cache.get('float'); if (cached && cached.until > Date.now()) return cached.value as number; const b = obj(await this.balance()); if (str(b.currency).toUpperCase() !== 'USD') throw new ShopError('account_currency_not_usd', 'Bitrefill account currency must be USD', 503); const cents = Number(b.balance); if (!Number.isSafeInteger(cents) || cents < 0) throw new ShopError('bitrefill_invalid_response', 'Invalid Bitrefill balance', 502); const value = cents / 100; this.cache.set('float', { value, until: Date.now() + 30_000 }); return value; }
  invalidateFloat() { this.cache.delete('float'); }
  searchProducts(q: string, country = 'IN'): Promise<SearchResult[]> { return this.cached(`s:${q}:${country}`, async () => parseSearch(this.key ? await this.request(`/products/search?q=${encodeURIComponent(q)}&country=${encodeURIComponent(country)}`) : await cli(['search-products', '--query', q, '--country', country, '--intent', 'Browse products for a guarded Oboro shop']))); }
  // REST v2 quotes `packages[].price` in the account's primary currency (BTC sats by default). The guardrails need USD,
  // so the REST path refuses unless the account's primary balance is USD; the no-key CLI path returns payment_price in USD.
  private accountCurrency(): Promise<string> { return this.cached('acct:currency', async () => str(obj(await this.balance()).currency).toUpperCase()); }
  getProduct(id: string, fresh = false): Promise<Product> {
    const load = async () => {
      if (!this.key) return parseProduct(await cli(['get-product-details', '--product_id', id]));
      const currency = await this.accountCurrency();
      if (currency !== 'USD') throw new ShopError('account_currency_not_usd', `Bitrefill quotes prices in the account's primary currency (${currency || 'unknown'}); make USD primary`, 503);
      const raw = obj(await this.request(`/products/${encodeURIComponent(id)}`));
      const packages = (Array.isArray(raw.packages) ? raw.packages : []).map((item: unknown) => { const pk = obj(item); return typeof pk.price === 'number' ? { ...pk, usd_price: pk.price } : pk; });
      return parseProduct({ ...raw, packages });
    };
    return fresh ? load() : this.cached(`p:${id}`, load);
  }
  createInvoice(input: InvoiceInput, permit?: typeof INVOICE_PERMIT): Promise<Invoice> { if (process.env.OBORO_BITREFILL_LIVE_BUY !== '1') throw new ShopError('live_buy_disabled', 'Setup required: OBORO_BITREFILL_LIVE_BUY=1', 503); if (permit !== INVOICE_PERMIT) throw new ShopError('guardrails_not_checked', 'Invoice creation requires an approved, reserved purchase', 403); return this.request('/invoices', { method: 'POST', body: JSON.stringify(input) }) as Promise<Invoice>; }
  getInvoice(id: string): Promise<Invoice> { return this.request(`/invoices/${encodeURIComponent(id)}`) as Promise<Invoice>; }
  getOrder(id: string): Promise<Order> { return this.request(`/orders/${encodeURIComponent(id)}`) as Promise<Order>; }
}

export interface GuardrailConfig { allow: { product_id: string; values: (string | number)[] }[]; maxUsdPerPurchase: number; maxUsdPerDay: number; maxPurchasesPerDay: number }
export const DEFAULT_GUARDRAILS: GuardrailConfig = { allow: [{ product_id: 'airtel-india', values: [10] }], maxUsdPerPurchase: 0.50, maxUsdPerDay: 1.50, maxPurchasesPerDay: 3 };
export function guardrailsFromEnv(value = process.env.OBORO_SHOP_ALLOW): GuardrailConfig { if (!value) return DEFAULT_GUARDRAILS; try { const x = JSON.parse(value) as GuardrailConfig; if (!Array.isArray(x.allow) || !x.allow.every(a => typeof a.product_id === 'string' && Array.isArray(a.values)) || ![x.maxUsdPerPurchase,x.maxUsdPerDay,x.maxPurchasesPerDay].every(n => Number.isFinite(n) && n >= 0)) throw Error(); return x; } catch { throw new ShopError('invalid_guardrails', 'OBORO_SHOP_ALLOW must be valid guardrail JSON', 500); } }
export type GuardrailDecision = { status: 'allowed'; usd: number } | { status: 'needs_approval'; usd: number; reason: string } | { status: 'refused'; reason: string };
export class Guardrails {
  constructor(readonly config = guardrailsFromEnv()) {}
  check(product: Product, value: string | number, totals: { usd: number; count: number }): GuardrailDecision {
    if (!product.in_stock) return { status: 'refused', reason: 'out_of_stock' };
    const allowed = this.config.allow.find(a => a.product_id === product.id);
    if (!allowed || !allowed.values.some(v => String(v) === String(value))) return { status: 'refused', reason: 'product_not_allowed' };
    const pkg = product.packages.find(p => p.value === String(value));
    if (!pkg) return { status: 'refused', reason: 'value_not_available' };
    if (pkg.usd > this.config.maxUsdPerPurchase) return { status: 'needs_approval', usd: pkg.usd, reason: 'per_purchase_cap' };
    if (Math.round((totals.usd + pkg.usd) * 100) > Math.round(this.config.maxUsdPerDay * 100)) return { status: 'needs_approval', usd: pkg.usd, reason: 'daily_usd_cap' };
    if (totals.count >= this.config.maxPurchasesPerDay) return { status: 'needs_approval', usd: pkg.usd, reason: 'daily_count_cap' };
    return { status: 'allowed', usd: pkg.usd };
  }
}
// Codes are cash. Values of 8 characters or fewer (PINs) are hidden entirely; longer ones keep 2 + 2 so an operator can
// tell two codes apart without being able to redeem either.
export function maskCode(value: string): string { return value.length <= 8 ? '*'.repeat(value.length) : `${value.slice(0, 2)}${'*'.repeat(Math.min(12, value.length - 4))}${value.slice(-2)}`; }
export function maskPhone(value?: string): string | undefined { if (!value) return undefined; const digits = value.replace(/\D/g, ''); return `${'*'.repeat(Math.min(10, Math.max(0, digits.length - 4)))}${digits.slice(-4)}`; }
export function maskPhoneTail(value: string): string { return `••${value.slice(-2)}`; }
export function maskRedemption(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined { if (!input) return undefined; return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? maskCode(v) : '[redacted]'])); }
export interface PurchaseRecord { receipt_id: string; txid: string; status: string; product_id: string; value: string; usd: number; phone_masked?: string; invoice_id?: string; order_ids: string[]; code_masked?: Record<string, unknown>; approval_id?: string; approved?: boolean; created_at: string; updated_at: string }
type LedgerState = { purchases: Record<string, PurchaseRecord> };
export class ShopLedger {
  constructor(readonly file: string) {}
  private async read(): Promise<LedgerState> { try { return JSON.parse(await readFile(this.file, 'utf8')) as LedgerState; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { purchases: {} }; throw e; } }
  private async write(state: LedgerState) { await mkdir(dirname(this.file), { recursive: true }); const tmp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`; const handle = await open(tmp, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); } await rename(tmp, this.file); }
  private async lock<T>(fn: (state: LedgerState) => Promise<T>): Promise<T> { const lock = `${this.file}.lock`; await mkdir(dirname(this.file), { recursive: true }); for (let i = 0; i < 100; i++) { try { await mkdir(lock); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; if (i === 99) throw new ShopError('ledger_busy', 'Shop ledger is busy', 503); await delay(25); } } try { const state = await this.read(); const result = await fn(state); await this.write(state); return result; } finally { await rm(lock, { recursive: true, force: true }); } }
  async reserve(input: { txid: string; product_id: string; value: string | number; usd: number; phone_number?: string; approval?: boolean }): Promise<PurchaseRecord> { if (!/^[a-f0-9]{64}$/i.test(input.txid) || !Number.isFinite(input.usd) || input.usd < 0) throw new ShopError('invalid_reservation', 'Invalid payment txid or catalog price', 400); return this.lock(async s => { if (s.purchases[input.txid]) throw new ShopError('duplicate_txid', 'This Zcash payment already authorised a purchase', 409); const now = new Date().toISOString(); const receipt_id = randomBytes(24).toString('hex'); const record: PurchaseRecord = { receipt_id, txid: input.txid, status: input.approval ? 'needs_approval' : 'reserved', product_id: input.product_id, value: String(input.value), usd: input.usd, phone_masked: maskPhone(input.phone_number), order_ids: [], approval_id: input.approval ? randomBytes(12).toString('hex') : undefined, created_at: now, updated_at: now }; s.purchases[input.txid] = record; return record; }); }
  async update(txid: string, patch: Partial<Omit<PurchaseRecord, 'txid' | 'phone_masked' | 'code_masked'>>) { return this.lock(async s => { const record = s.purchases[txid]; if (!record) throw new ShopError('receipt_unknown', 'Purchase not found', 404); Object.assign(record, patch, { updated_at: new Date().toISOString() }); return record; }); }
  async delivered(txid: string, order: Order) { return this.lock(async s => { const r = s.purchases[txid]; if (!r) throw new ShopError('receipt_unknown', 'Purchase not found', 404); r.status = 'delivered'; r.order_ids = [...new Set([...r.order_ids, order.id])]; r.code_masked = maskRedemption(order.redemption_info); r.updated_at = new Date().toISOString(); return r; }); }
  async approve(id: string) { return this.lock(async s => { const r = Object.values(s.purchases).find(p => p.approval_id === id); if (!r || r.status !== 'needs_approval') throw new ShopError('approval_unknown', 'Approval not found or already used', 404); r.approved = true; r.updated_at = new Date().toISOString(); return r; }); }
  async byReceipt(id: string) { return Object.values((await this.read()).purchases).find(p => p.receipt_id === id); }
  async byTxid(id: string) { return (await this.read()).purchases[id]; }
  async list() { return Object.values((await this.read()).purchases); }
  async today(now = new Date()) { const day = indiaDay(now); const entries = (await this.list()).filter(p => indiaDay(new Date(p.created_at)) === day && p.status !== 'needs_approval' && p.status !== 'refused'); return { usd: Math.round(entries.reduce((sum,p) => sum + p.usd, 0) * 100) / 100, count: entries.length }; }
}
export interface CommerceConnector {
  name: string;
  hasKey(): boolean;
  search(q: string): Promise<SearchResult[]>;
  product(id: string, fresh?: boolean): Promise<Product>;
  buy(guardrails: Guardrails, ledger: ShopLedger, txid: string, input: { product_id: string; value: number | string; phone_number?: string }): Promise<{ invoice: Invoice; order: Order }>;
  status(id: string): Promise<Invoice>;
}
export function bitrefillConnector(client = new BitrefillClient()): CommerceConnector {
  return {
    name: 'bitrefill',
    hasKey: () => client.hasKey(),
    search: (q) => client.searchProducts(q, 'IN'),
    product: (id, fresh) => client.getProduct(id, fresh),
    buy: (guardrails, ledger, txid, input) => fulfil(client, guardrails, ledger, txid, input),
    status: (id) => client.getInvoice(id)
  };
}
export function classify(invoice: Invoice, order?: Order): 'poll' | 'delivered' | 'failed' | 'refunded' | 'blocked' | 'denied' | 'payment_error' {
  if (['blocked', 'denied', 'payment_error'].includes(invoice.status)) return invoice.status as 'blocked' | 'denied' | 'payment_error';
  if (order?.status === 'failed' || order?.status === 'refunded') return order.status;
  return order?.status === 'delivered' ? 'delivered' : 'poll';
}
// Numeric values go as `value`; a named package (e.g. a Jio plan) goes as Bitrefill's package id `<product><&><name>`.
const pkgRef = (product_id: string, value: number | string) => typeof value === 'number' ? { value } : { package_id: `${product_id}<&>${value}` };
export async function fulfil(client: BitrefillClient, guardrails: Guardrails, ledger: ShopLedger, txid: string, input: { product_id: string; value: number | string; phone_number?: string }, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<{ invoice: Invoice; order: Order }> {
  const existing = await ledger.byTxid(txid);
  if (!existing || !['reserved', 'processing'].includes(existing.status)) throw new ShopError('purchase_not_reserved', 'Purchase must be reserved before invoice creation', 409);
  if (process.env.OBORO_BITREFILL_LIVE_BUY !== '1') throw new ShopError('live_buy_disabled', 'Setup required: OBORO_BITREFILL_LIVE_BUY=1', 503);
  if (!client.hasKey()) throw new ShopError('setup_required', 'Setup required: BITREFILL_API_KEY', 503);
  if (existing.product_id !== input.product_id || existing.value !== String(input.value)) throw new ShopError('reservation_mismatch', 'Reserved purchase differs from invoice request', 409);
  const product = await client.getProduct(input.product_id, true);
  const totals = await ledger.today();
  const check = guardrails.check(product, input.value, { usd: Math.max(0, totals.usd - existing.usd), count: Math.max(0, totals.count - 1) });
  if (check.status === 'refused') throw new ShopError(check.reason, `Purchase refused: ${check.reason}`, 400);
  if (check.status === 'needs_approval' && !existing.approved) throw new ShopError('needs_approval', 'Purchase exceeds guardrails and needs human approval', 409);
  if (check.usd !== existing.usd) throw new ShopError('price_changed', 'Catalog price changed after reservation; reapproval required', 409);
  const timeout = Date.now() + (options.timeoutMs ?? 300_000);
  let invoice: Invoice;
  if (existing.invoice_id) invoice = await client.getInvoice(existing.invoice_id);
  else { invoice = await client.createInvoice({ products: [{ product_id: input.product_id, ...pkgRef(input.product_id, input.value), quantity: 1, ...(input.phone_number ? { phone_number: input.phone_number } : {}) }], payment_method: 'balance', auto_pay: true }, INVOICE_PERMIT); await ledger.update(txid, { invoice_id: invoice.id, status: 'processing' }); }
  let expiredRetry = false;
  while (Date.now() < timeout) {
    invoice = await client.getInvoice(invoice.id);
    if (invoice.status === 'expired') {
      if (expiredRetry) { await ledger.update(txid, { status: 'expired' }); throw new ShopError('invoice_expired', 'Bitrefill replacement invoice expired', 502); }
      const latest = await client.getProduct(input.product_id, true);
      const retryCheck = guardrails.check(latest, input.value, { usd: Math.max(0, (await ledger.today()).usd - existing.usd), count: Math.max(0, (await ledger.today()).count - 1) });
      if (retryCheck.status === 'refused' || (retryCheck.status === 'needs_approval' && !existing.approved) || retryCheck.usd !== existing.usd) throw new ShopError('retry_guardrails_failed', 'Replacement invoice no longer passes guardrails', 409);
      expiredRetry = true; invoice = await client.createInvoice({ products: [{ product_id: input.product_id, ...pkgRef(input.product_id, input.value), quantity: 1, ...(input.phone_number ? { phone_number: input.phone_number } : {}) }], payment_method: 'balance', auto_pay: true }, INVOICE_PERMIT); await ledger.update(txid, { invoice_id: invoice.id }); continue;
    }
    const orderId = invoice.orders?.[0]?.id;
    if (orderId) { await ledger.update(txid, { order_ids: invoice.orders.map(o => o.id) }); const order = await client.getOrder(orderId); const state = classify(invoice, order); if (state === 'delivered') { await ledger.delivered(txid, order); return { invoice, order }; } if (state !== 'poll') { await ledger.update(txid, { status: state }); throw new ShopError(`purchase_${state}`, `Bitrefill purchase ${state}`, 502); } }
    else { const state = classify(invoice); if (state !== 'poll') { await ledger.update(txid, { status: state }); throw new ShopError(`invoice_${state}`, `Bitrefill invoice ${state}`, 502); } }
    await delay(options.intervalMs ?? 2_000);
  }
  await ledger.update(txid, { status: 'processing' });
  throw new ShopError('fulfilment_timeout', 'Bitrefill delivery is still processing', 202);
}
export async function fulfilRelay(client: BitrefillClient, ledger: { byTxid(txid: string): Promise<{ status: string; product_id: string; value: string; usd: number; kind?: 'card' | 'recharge'; invoice_id?: string } | undefined>; today(): Promise<number> }, txid: string, limits: { maxUsdPerSale: number; maxUsdPerDay: number }, options: { timeoutMs?: number; intervalMs?: number; phoneNumber?: string; onInvoice?: (invoice: Invoice) => Promise<void>; onOrders?: (ids: string[]) => Promise<void> } = {}): Promise<{ invoice: Invoice; order: Order }> {
  const sale = await ledger.byTxid(txid);
  if (!sale || !['paid', 'buying'].includes(sale.status)) throw new ShopError('purchase_not_reserved', 'Relay sale must be reserved before invoice creation', 409);
  if (sale.usd > limits.maxUsdPerSale || await ledger.today() > limits.maxUsdPerDay) throw new ShopError('over_daily_limit', 'Relay limit exceeded', 409);
  // The concrete BitrefillClient enforces the live-buy switch at createInvoice.
  if (!client.hasKey()) throw new ShopError('setup_required', 'Setup required: BITREFILL_API_KEY', 503);
  if (sale.kind === 'recharge' && !sale.invoice_id && !options.phoneNumber) throw new ShopError('phone_lost', 'Recharge phone number is no longer available', 410);
  if (!sale.invoice_id) {
    const product = await client.getProduct(sale.product_id, true);
    const pkg = product.packages.find(p => p.value === sale.value);
    if (!product.in_stock || !pkg || pkg.usd !== sale.usd) throw new ShopError('price_changed', 'Package changed since payment', 409);
    if (await client.floatUsd() < sale.usd) throw new ShopError('float_empty', 'Relay float is insufficient', 409);
  }
  const value = /^\d+(?:\.\d+)?$/.test(sale.value) ? Number(sale.value) : sale.value;
  const invoice = sale.invoice_id ? await client.getInvoice(sale.invoice_id) : await client.createInvoice({ products: [{ product_id: sale.product_id, ...pkgRef(sale.product_id, value), quantity: 1, ...(sale.kind === 'recharge' ? { phone_number: options.phoneNumber } : {}) }], payment_method: 'balance', auto_pay: true }, INVOICE_PERMIT);
  if (!sale.invoice_id) client.invalidateFloat();
  await options.onInvoice?.(invoice);
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  while (Date.now() < deadline) {
    const current = await client.getInvoice(invoice.id);
    if (current.status === 'expired') throw new ShopError('invoice_expired', 'Bitrefill invoice expired', 502);
    const id = current.orders?.[0]?.id;
    if (id) { await options.onOrders?.(current.orders.map(o => o.id)); const order = await client.getOrder(id); const state = classify(current, order); if (state === 'delivered') return { invoice: current, order }; if (state !== 'poll') throw new ShopError(`purchase_${state}`, `Bitrefill purchase ${state}`, 502); }
    else { const state = classify(current); if (state !== 'poll') throw new ShopError(`invoice_${state}`, `Bitrefill invoice ${state}`, 502); }
    await delay(options.intervalMs ?? 2_000);
  }
  throw new ShopError('fulfilment_timeout', 'Bitrefill delivery is still processing', 202);
}
