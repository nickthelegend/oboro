import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { BitrefillClient, bitrefillConnector, Guardrails, ShopLedger } from '@oboro/shop';
import { mountShop } from './shop-routes.js';

it('free dashboard exposes masked state without bearer tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oboro-shop-route-'));
  try {
    const ledger = new ShopLedger(join(dir, 'shop.json'));
    const record = await ledger.reserve({ txid: 'b'.repeat(64), product_id: 'airtel-india', value: 10, usd: 0.11, phone_number: '+919876543210', approval: true });
    await ledger.delivered(record.txid, { id: 'order1', status: 'delivered', redemption_info: { code: 'ABSECRET12CD' } });
    const routes = new Map<string, (...args: any[]) => void>();
    const app = { get: (path: string, fn: (...args: any[]) => void) => { routes.set(path, fn); }, post: () => {} } as unknown as Express;
    mountShop(app, { paywall: { price: () => (_req, _res, next) => next() }, connector: bitrefillConnector(new BitrefillClient('')), guardrails: new Guardrails(), ledger });
    const body = await new Promise<string>(resolve => routes.get('/oboro/shop')!({}, { json: (v: unknown) => resolve(JSON.stringify(v)) }));
    expect(body).not.toContain(record.receipt_id); expect(body).not.toContain(record.approval_id);
    expect(body).not.toContain(record.txid); expect(body).not.toContain('9876543210'); expect(body).not.toContain('ABSECRET12CD'); expect(body).toContain('AB********CD');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
