import type { Express, NextFunction, Request, Response } from 'express';
import { decodePayment } from 'oboro';
import { BitrefillClient, fulfil, Guardrails, ShopError, ShopLedger, type Order, type Product } from '@oboro/shop';

type Paywall = { price(zats: number, description: string): (req: Request, res: Response, next: NextFunction) => void };
type Options = { paywall: Paywall; client: BitrefillClient; guardrails: Guardrails; ledger: ShopLedger };
type Pending = { promise: Promise<{ invoice_id: string; order_id: string; redemption?: Record<string, unknown> }>; product: Product; value: string; usd: number };
const problem = (res: Response, error: unknown) => { const e = error instanceof ShopError ? error : new ShopError('shop_internal_error', 'Shop operation failed'); res.status(e.httpStatus === 202 ? 202 : e.httpStatus).json({ code: e.code, error: e.message }); };
const validId = (value: string) => /^[a-z0-9][a-z0-9-]{0,100}$/i.test(value);
const validPhone = (value: unknown) => typeof value === 'string' && /^\+[1-9][0-9]{7,14}$/.test(value);

export function mountShop(app: Express, { paywall, client, guardrails, ledger }: Options) {
  // Unmasked redemption data lives only in memory until the buyer retrieves its paid receipt.
  const pending = new Map<string, Pending>();
  const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => { void fn(req, res).catch(error => problem(res, error)); };
  app.get('/v1/shop/search', asyncRoute(async (req, res) => {
    const q = String(req.query.q ?? '').trim(); if (!q || q.length > 80) throw new ShopError('invalid_query', 'Search query must be 1–80 characters', 400);
    res.json({ products: await client.searchProducts(q, 'IN') });
  }));
  app.get('/v1/shop/product/:id', asyncRoute(async (req, res) => {
    const id = String(req.params.id); if (!validId(id)) throw new ShopError('invalid_product_id', 'Invalid product id', 400);
    res.json(await client.getProduct(id));
  }));
  app.post('/v1/shop/buy', paywall.price(5_000, 'Authorise one Bitrefill purchase (paid from event credits)'), asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const id = body?.product_id; const value = body?.value; const phone = body?.phone_number;
    if (typeof id !== 'string' || !validId(id) || !(typeof value === 'string' || typeof value === 'number') || !/^\d+(?:\.\d+)?$/.test(String(value))) throw new ShopError('invalid_purchase', 'product_id and numeric value are required', 400);
    if (id === 'airtel-india' && !validPhone(phone)) throw new ShopError('invalid_phone', 'Airtel India requires an international phone number', 400);
    if (phone !== undefined && !validPhone(phone)) throw new ShopError('invalid_phone', 'phone_number must use international format', 400);
    const header = req.get('X-PAYMENT'); if (!header) throw new ShopError('payment_missing', 'X-PAYMENT is required', 402);
    const txid = decodePayment(header).payload.txid;
    const product = await client.getProduct(id, true);
    const decision = guardrails.check(product, value, await ledger.today());
    if (decision.status === 'refused') throw new ShopError(decision.reason, `Purchase refused: ${decision.reason}`, 400);
    if (decision.status === 'allowed') {
      if (!client.hasKey()) throw new ShopError('setup_required', 'Setup required: BITREFILL_API_KEY', 503);
      if (process.env.OBORO_BITREFILL_LIVE_BUY !== '1') throw new ShopError('live_buy_disabled', 'Setup required: OBORO_BITREFILL_LIVE_BUY=1', 503);
    }
    const record = await ledger.reserve({ txid, product_id: id, value, usd: decision.usd, phone_number: typeof phone === 'string' ? phone : undefined, approval: decision.status === 'needs_approval' });
    const start = () => {
      const promise = fulfil(client, guardrails, ledger, txid, { product_id: id, value: Number(value), phone_number: typeof phone === 'string' ? phone : undefined })
        .then(({ invoice, order }) => ({ invoice_id: invoice.id, order_id: order.id, redemption: order.redemption_info }));
      pending.set(record.receipt_id, { promise, product, value: String(value), usd: decision.usd });
      // Prevent an unhandled rejection when no receipt request is in flight.
      void promise.catch(() => undefined);
      return promise;
    };
    if (decision.status === 'needs_approval') {
      pending.set(record.receipt_id, { promise: Promise.resolve({ invoice_id: '', order_id: '' }), product, value: String(value), usd: decision.usd });
      approvalInputs.set(record.receipt_id, { start, phone: typeof phone === 'string' ? phone : undefined });
      res.status(202).json({ status: 'needs_approval', approval_id: record.approval_id, receipt_id: record.receipt_id }); return;
    }
    const task = start();
    const outcome = await Promise.race([task.then(result => ({ done: true as const, result }), error => ({ done: true as const, error })), new Promise<{ done: false }>(resolve => setTimeout(() => resolve({ done: false }), 25_000))]);
    if (!outcome.done) { res.status(202).json({ status: 'processing', receipt_id: record.receipt_id }); return; }
    if ('error' in outcome) throw outcome.error;
    pending.delete(record.receipt_id);
    res.json({ status: 'delivered', invoice_id: outcome.result.invoice_id, order_id: outcome.result.order_id, product: product.name, value: String(value), usd: decision.usd, redemption: outcome.result.redemption });
  }));
  const approvalInputs = new Map<string, { start: () => Promise<unknown>; phone?: string }>();
  app.get('/v1/shop/receipt/:id', asyncRoute(async (req, res) => {
    const id = String(req.params.id); if (!/^[a-f0-9]{48}$/.test(id)) throw new ShopError('receipt_unknown', 'Receipt not found', 404);
    const record = await ledger.byReceipt(id); if (!record) throw new ShopError('receipt_unknown', 'Receipt not found', 404);
    if (record.status === 'needs_approval') {
      if (!record.approved) { res.status(202).json({ status: 'needs_approval', approval_id: record.approval_id }); return; }
      const approval = approvalInputs.get(id);
      if (!approval) throw new ShopError('approval_context_lost', 'Approval accepted, but the server lost purchase context; contact the operator', 503);
      if (!client.hasKey()) throw new ShopError('setup_required', 'Setup required: BITREFILL_API_KEY', 503);
      if (process.env.OBORO_BITREFILL_LIVE_BUY !== '1') throw new ShopError('live_buy_disabled', 'Setup required: OBORO_BITREFILL_LIVE_BUY=1', 503);
      await ledger.update(record.txid, { status: 'reserved' }); approvalInputs.delete(id); void approval.start();
    }
    const item = pending.get(id);
    if (!item) { res.json({ status: record.status, invoice_id: record.invoice_id, order_ids: record.order_ids, code_masked: record.code_masked }); return; }
    const outcome = await Promise.race([item.promise.then(result => ({ done: true as const, result }), error => ({ done: true as const, error })), new Promise<{ done: false }>(resolve => setTimeout(() => resolve({ done: false }), 20_000))]);
    if (!outcome.done) { res.status(202).json({ status: 'processing', receipt_id: id }); return; }
    pending.delete(id);
    if ('error' in outcome) throw outcome.error;
    res.json({ status: 'delivered', invoice_id: outcome.result.invoice_id, order_id: outcome.result.order_id, product: item.product.name, value: item.value, usd: item.usd, redemption: outcome.result.redemption });
  }));
  app.get('/oboro/shop', asyncRoute(async (_req, res) => {
    const setup = [!client.hasKey() && 'BITREFILL_API_KEY', process.env.OBORO_BITREFILL_LIVE_BUY !== '1' && 'OBORO_BITREFILL_LIVE_BUY=1'].filter(Boolean);
    const publicLedger = (await ledger.list()).map(({ receipt_id: _receiptToken, approval_id: _approvalId, txid, ...masked }) => ({ ...masked, txid: `${txid.slice(0, 8)}…${txid.slice(-8)}` }));
    res.json({ ledger: publicLedger, guardrails: guardrails.config, today: await ledger.today(), setup });
  }));
}
