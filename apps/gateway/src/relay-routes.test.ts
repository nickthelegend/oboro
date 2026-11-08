import { expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BitrefillClient, Relay, RelayLedger } from '@oboro/shop';
import { mountRelay } from './relay-routes.js';
it('marks recharge catalog amounts and validates phone numbers before the paywall can charge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oboro-recharge-route-'));
  try {
    const routes = new Map<string, (...args: any[]) => void>();
    const app = { get: (path: string, ...fns: ((...args: any[]) => void)[]) => { routes.set('GET ' + path, fns.at(-1)!); }, post: (path: string, ...fns: ((...args: any[]) => void)[]) => { routes.set('POST ' + path, fns.at(-1)!); } } as unknown as Express;
    const products = {
      'reliance-jio-india-bundles': { id: 'reliance-jio-india-bundles', name: 'Jio', recipient_type: 'phone_number', currency: 'INR', in_stock: true, packages: [{ value: '1.5GB/Day – 28 Days', amount: 299, usd: 3.32, currency: 'INR' }] },
      'blink-it-india': { id: 'blink-it-india', name: 'Blinkit', recipient_type: 'none', currency: 'INR', in_stock: true, packages: [{ value: '250', usd: 3, currency: 'INR' }] },
    };
    const client = { hasKey: () => true, floatUsd: async () => 8.74, getProduct: async (id: keyof typeof products) => products[id], createInvoice: vi.fn() } as unknown as BitrefillClient;
    const ledger = new RelayLedger(join(dir, 'relay.json'));
    const relay = new Relay(client, ledger, { catalog: [{ product_id: 'reliance-jio-india-bundles', values: ['1.5GB/Day – 28 Days'] }, { product_id: 'blink-it-india', values: [250] }], maxUsdPerSale: 6, maxUsdPerDay: 9 }, async () => ({ usd: 300, source: 'kraken', at: '' }));
    let priceFor: (req: any) => Promise<unknown> = async () => undefined;
    mountRelay(app, { paywall: { priceFor: resolve => { priceFor = resolve; return (_req, _res, next) => next(); } }, relay, sellerWallet: { pay: async () => ({ txid: 'a'.repeat(64) }) } });
    const invoke = (key: string, body?: unknown) => new Promise<{ status: number; body: any }>(resolve => { let status = 200; const res = { status: (n: number) => { status = n; return res; }, json: (v: unknown) => resolve({ status, body: v }) }; routes.get(key)!({ body }, res); });
    const catalog = await invoke('GET /v1/cards/catalog');
    expect(catalog.body.products).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'recharge', packages: [expect.objectContaining({ amount: 299 })] }), expect.objectContaining({ kind: 'card' })]));
    const recharge = await relay.quote('reliance-jio-india-bundles', '1.5GB/Day – 28 Days');
    const card = await relay.quote('blink-it-india', 250);
    const request = (quote_id: string, phone_number?: unknown) => ({ body: { quote_id, ...(phone_number !== undefined ? { phone_number } : {}) }, get: () => undefined });
    for (const phone of [undefined, '1234', '+0123456789', '+919876543283x']) await expect(priceFor(request(recharge.quote_id, phone))).rejects.toMatchObject({ code: 'invalid_phone', httpStatus: 400 });
    await expect(priceFor(request(card.quote_id, '+919876543283'))).rejects.toMatchObject({ code: 'phone_not_expected', httpStatus: 400 });
    const sale = await ledger.reserve(recharge, 'b'.repeat(64), undefined, 9, '+919876543283');
    await ledger.update(sale.txid, { status: 'buying' });
    const publicView = await invoke('GET /oboro/relay');
    expect(publicView.body.sales[0]).toMatchObject({ kind: 'recharge', phone_masked: '••83' });
    expect(JSON.stringify(publicView.body)).not.toContain('+919876543283');
    expect(publicView.body.relay_never_saw).not.toContain('phone number');
    const receipt = (id: string) => new Promise<{ status: number; body: any }>(resolve => { let status = 200; const res = { status: (n: number) => { status = n; return res; }, json: (v: unknown) => resolve({ status, body: v }) }; routes.get('GET /v1/cards/receipt/:id')!({ params: { id }, query: {} }, res); });
    expect((await receipt(sale.receipt_id)).status).toBe(202);
    for (let i = 0; i < 20 && (await ledger.byTxid(sale.txid))?.status === 'buying'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(await ledger.byTxid(sale.txid)).toMatchObject({ status: 'failed', refund_owed: true });
    expect(client.createInvoice).not.toHaveBeenCalled();
    const delivered = await ledger.reserve(recharge, 'c'.repeat(64), undefined, 9, '+919876543283');
    await ledger.update(delivered.txid, { status: 'delivered', invoice_id: 'invoice-2', order_ids: ['order-2'] });
    const delivery = await receipt(delivered.receipt_id);
    expect(delivery.body).toMatchObject({ status: 'delivered', kind: 'recharge', phone_masked: '••83', amount: 299, order_id: 'order-2' });
    expect(delivery.body).not.toHaveProperty('code_masked');
    expect(delivery.body).not.toHaveProperty('redemption');
    expect(delivery.body).not.toHaveProperty('sealed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('shows setup without invented prices and validates quotes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oboro-relay-route-'));
  try {
    const routes = new Map<string, (...args: any[]) => void>();
    const app = { get: (path: string, ...fns: ((...args: any[]) => void)[]) => { routes.set('GET ' + path, fns.at(-1)!); }, post: (path: string, ...fns: ((...args: any[]) => void)[]) => { routes.set('POST ' + path, fns.at(-1)!); } } as unknown as Express;
    const relay = new Relay(new BitrefillClient(''), new RelayLedger(join(dir, 'relay.json')), undefined, async () => ({ usd: 300, source: 'kraken', at: '' }));
    mountRelay(app, { paywall: { priceFor: () => (_req, _res, next) => next() }, relay, sellerWallet: { pay: async () => ({ txid: 'a'.repeat(64) }) } });
    const invoke = (key: string, body?: unknown) => new Promise<{ status: number; body: any }>(resolve => {
      let status = 200;
      const res = { status: (n: number) => { status = n; return res; }, json: (v: unknown) => resolve({ status, body: v }) };
      routes.get(key)!({ body }, res);
    });
    const catalog = await invoke('GET /v1/cards/catalog');
    expect(catalog.body.products).toEqual([]); expect(catalog.body.setup).toContain('BITREFILL_API_KEY');
    const bad = await invoke('POST /v1/cards/quote', { product_id: '../bad', value: 250 });
    expect(bad).toMatchObject({ status: 400, body: { code: 'invalid_quote' } });
    const missing = await invoke('POST /v1/cards/quote', { product_id: 'other', value: 250 });
    expect(missing).toMatchObject({ status: 409, body: { code: 'not_in_catalog' } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
