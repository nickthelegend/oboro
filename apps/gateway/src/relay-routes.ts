import type { Express, NextFunction, Request, Response } from 'express';
import { addressPrefix, decodePayment, seal, validSealTo } from 'oboro';
import { fulfilRelay, Relay, ShopError, usdToZats, type RelaySale } from '@oboro/shop';

type Paywall = { priceFor(resolve: (req: { path: string; body?: any; get(name: string): string | undefined }) => Promise<{ zats: number; description: string; binding: string; expiresAt?: string }>): (req: Request, res: Response, next: NextFunction) => void };
type Wallet = { pay(to: string, zats: number, memo: string): Promise<{ txid: string }> };
const idOk = (v: unknown) => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,100}$/.test(v);
const receiptOk = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{48}$/.test(v);
const problem = (res: Response, error: unknown) => { const e = error instanceof ShopError ? error : new ShopError('relay_internal_error', 'Relay operation failed'); res.status(e.httpStatus).json({ code: e.code, error: e.message }); };
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => { void fn(req, res).catch(error => problem(res, error)); };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export function mountRelay(app: Express, { paywall, relay, sellerWallet }: { paywall: Paywall; relay: Relay; sellerWallet: Wallet }) {
  const pending = new Map<string, Promise<void>>();
  const codes = new Map<string, Record<string, unknown>>();
  const refundAddresses = new Map<string, string>();
  const delivery = (sale: RelaySale, sealTo?: string) => {
    const redemption = codes.get(sale.receipt_id);
    return { status: sale.status, receipt_id: sale.receipt_id, invoice_id: sale.invoice_id, order_id: sale.order_ids[0], product: sale.name, value: sale.value, currency: sale.currency, usd: sale.usd, zats: sale.zats, zec_usd: sale.zec_usd, txid: sale.txid, ...(redemption ? sealTo ? { sealed: seal(redemption, sealTo) } : { redemption } : { code_masked: sale.code_masked }) };
  };
  const refund = async (sale: RelaySale) => {
    const address = refundAddresses.get(sale.receipt_id); refundAddresses.delete(sale.receipt_id);
    if (!address || sale.zats <= 10_000) { await relay.ledger.update(sale.txid, { status: 'failed', refund_owed: true }); return; }
    try { const { txid } = await sellerWallet.pay(address, sale.zats - 10_000, `oboro:refund-${sale.receipt_id.slice(0, 16)}`); await relay.ledger.update(sale.txid, { status: 'refunded', refund_txid: txid }); }
    catch { await relay.ledger.update(sale.txid, { status: 'failed', refund_owed: true }); }
  };
  const start = (sale: RelaySale) => {
    const task = (async () => {
      try {
        await relay.ledger.update(sale.txid, { status: 'buying' });
        const { invoice, order } = await fulfilRelay(relay.client, relay.ledger, sale.txid, relay.config, { onInvoice: async invoice => { await relay.ledger.update(sale.txid, { invoice_id: invoice.id }); }, onOrders: async ids => { await relay.ledger.update(sale.txid, { order_ids: ids }); } });
        await relay.ledger.update(sale.txid, { invoice_id: invoice.id, order_ids: invoice.orders.map(o => o.id) });
        codes.set(sale.receipt_id, order.redemption_info ?? {});
        await relay.ledger.delivered(sale.txid, order.id, order.redemption_info);
      } catch (e) {
        // A transport timeout does not prove that Bitrefill did not create or deliver the order.
        const terminal = e instanceof ShopError && /^(?:purchase_(?:failed|refunded|blocked|denied|payment_error)|invoice_(?:failed|refunded|blocked|denied|payment_error|expired)|price_changed|float_empty|over_daily_limit|setup_required)$/.test(e.code);
        if (terminal) await refund(sale);
      }
      finally { pending.delete(sale.receipt_id); }
    })();
    pending.set(sale.receipt_id, task); void task.catch(() => undefined);
    return task;
  };
  app.get('/v1/cards/catalog', asyncRoute(async (_req, res) => {
    const setup = [!relay.client.hasKey() && 'BITREFILL_API_KEY', process.env.OBORO_BITREFILL_LIVE_BUY !== '1' && 'OBORO_BITREFILL_LIVE_BUY'].filter(Boolean);
    const rate = await relay.rate(); const sold = await relay.ledger.today();
    if (!relay.client.hasKey()) { res.json({ rate, float_usd: null, limits: { max_usd_per_sale: relay.config.maxUsdPerSale, max_usd_per_day: relay.config.maxUsdPerDay, sold_today_usd: sold }, products: [], setup }); return; }
    const float = await relay.client.floatUsd();
    const products = await Promise.all(relay.config.catalog.map(async entry => {
      const p = await relay.client.getProduct(entry.product_id, true);
      return { product_id: p.id, name: p.name, currency: p.currency, in_stock: p.in_stock, packages: entry.values.map(value => {
        const pkg = p.packages.find(x => x.value === String(value)); const usd = pkg?.usd ?? 0;
        const reason = !p.in_stock || !pkg ? 'value_not_available' : usd > relay.config.maxUsdPerSale ? 'over_sale_limit' : sold + usd > relay.config.maxUsdPerDay ? 'over_daily_limit' : usd > float ? 'float_empty' : undefined;
        return { value: String(value), usd, zats: pkg ? usdToZats(usd, rate.usd) : 0, available: !reason, ...(reason ? { reason } : {}) };
      }) };
    }));
    res.json({ rate, float_usd: float, limits: { max_usd_per_sale: relay.config.maxUsdPerSale, max_usd_per_day: relay.config.maxUsdPerDay, sold_today_usd: sold }, products, setup });
  }));
  app.post('/v1/cards/quote', asyncRoute(async (req, res) => {
    const { product_id, value } = req.body ?? {};
    if (!idOk(product_id) || !(typeof value === 'number' || typeof value === 'string') || !/^(?:\d+(?:\.\d+)?|[\w .+/–-]{1,80})$/.test(String(value))) throw new ShopError('invalid_quote', 'Invalid product or value', 400);
    res.json(await relay.quote(product_id, value));
  }));
  const resolveQuote = async (req: { body?: any; get(name: string): string | undefined }) => {
    const id = req.body?.quote_id;
    if (!receiptOk(id)) throw new ShopError('invalid_quote', 'Invalid quote ID', 400);
    const q = await relay.ledger.getQuote(id);
    if (!q || (!req.get('X-PAYMENT') && Date.now() >= Date.parse(q.expires_at))) throw new ShopError('quote_expired', 'Quote expired', 410);
    if (!relay.client.hasKey()) throw new ShopError('setup_required', 'Setup required: BITREFILL_API_KEY', 503);
    if (process.env.OBORO_BITREFILL_LIVE_BUY !== '1') throw new ShopError('setup_required', 'Setup required: OBORO_BITREFILL_LIVE_BUY', 503);
    return { zats: q.zats, binding: q.quote_id, expiresAt: q.expires_at, description: `${q.name} ${q.currency} ${q.value} at ${q.zec_usd} USD/ZEC` };
  };
  app.post('/v1/cards/buy', paywall.priceFor(resolveQuote), asyncRoute(async (req, res) => {
    const quote = await relay.ledger.getQuote(req.body.quote_id);
    if (!quote) throw new ShopError('quote_expired', 'Quote expired', 410);
    const sealTo = req.body.seal_to; if (sealTo !== undefined && !validSealTo(sealTo)) throw new ShopError('invalid_seal_to', 'Invalid X25519 public key', 400);
    const refundTo = req.body.refund_to; if (refundTo !== undefined && (typeof refundTo !== 'string' || !new RegExp(`^${addressPrefix('zcash-testnet')}[a-z0-9]{20,}$`).test(refundTo))) throw new ShopError('invalid_refund_to', 'Invalid testnet unified address', 400);
    const txid = decodePayment(req.get('X-PAYMENT') ?? '').payload.txid;
    const sale = await relay.ledger.reserve(quote, txid, refundTo, relay.config.maxUsdPerDay);
    if (refundTo) refundAddresses.set(sale.receipt_id, refundTo);
    if (sale.overLimit) { await refund(sale); const current = await relay.ledger.byReceipt(sale.receipt_id); res.status(409).json({ code: 'over_daily_limit', status: current?.status, receipt_id: sale.receipt_id, refund_txid: current?.refund_txid, refund_owed: current?.refund_owed }); return; }
    const task = start(sale);
    await Promise.race([task, wait(25_000)]);
    const current = await relay.ledger.byReceipt(sale.receipt_id);
    if (current?.status === 'delivered') { res.json(delivery(current, sealTo)); return; }
    if (current?.status === 'refunded' || current?.status === 'failed') { res.status(502).json({ status: current.status, receipt_id: sale.receipt_id, refund_txid: current.refund_txid, refund_owed: current.refund_owed }); return; }
    res.status(202).json({ status: 'buying', receipt_id: sale.receipt_id });
  }));
  app.get('/v1/cards/receipt/:id', asyncRoute(async (req, res) => {
    const id = String(req.params.id); if (!receiptOk(id)) throw new ShopError('receipt_unknown', 'Receipt not found', 404);
    const sealTo = req.query.seal_to; if (sealTo !== undefined && !validSealTo(sealTo)) throw new ShopError('invalid_seal_to', 'Invalid X25519 public key', 400);
    const sale = await relay.ledger.byReceipt(id); if (!sale) throw new ShopError('receipt_unknown', 'Receipt not found', 404);
    if (sale.status === 'buying' && sale.invoice_id && !pending.has(id)) start(sale);
    if (sale.status === 'buying' || sale.status === 'paid') { res.status(202).json({ status: 'buying', receipt_id: id }); return; }
    const result = delivery(sale, sealTo); codes.delete(id); res.json(result);
  }));
  app.get('/oboro/relay', asyncRoute(async (_req, res) => {
    const sales = (await relay.ledger.list()).map(s => ({ name: s.name, value: s.value, currency: s.currency, usd: s.usd, zats: s.zats, zec_usd: s.zec_usd, txid: `${s.txid.slice(0, 8)}…${s.txid.slice(-8)}`, status: s.status, created_at: s.created_at, delivered_at: s.delivered_at, invoice_id: s.invoice_id }));
    res.json({ sales, relay_knows: ['product', 'price', 'txid', 'time'], relay_never_saw: ['IP address', 'Nym address', 'payer address', 'account', 'email', 'phone number'], today: await relay.ledger.today(), float_usd: relay.client.hasKey() ? await relay.client.floatUsd() : null, rate: await relay.rate() });
  }));
}
