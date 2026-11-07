import { afterEach, expect, it } from 'vitest';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BitrefillClient, bitrefillConnector, Guardrails, ShopLedger } from '@oboro/shop';
import { mountShop } from './shop-routes.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('free dashboard exposes masked state without receipt or approval bearer tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oboro-shop-route-')); dirs.push(dir);
  const ledger = new ShopLedger(join(dir, 'shop.json'));
  const record = await ledger.reserve({ txid: 'b'.repeat(64), product_id: 'airtel-india', value: 10, usd: 0.11, phone_number: '+919876543210', approval: true });
  await ledger.delivered(record.txid, { id: 'order1', status: 'delivered', redemption_info: { code: 'ABSECRET12CD' } });
  const app = express();
  mountShop(app, { paywall: { price: () => (_req, _res, next) => next() }, connector: bitrefillConnector(new BitrefillClient('')), guardrails: new Guardrails(), ledger });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('No TCP port');
    const response = await fetch(`http://127.0.0.1:${address.port}/oboro/shop`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(record.receipt_id);
    expect(body).not.toContain(record.approval_id);
    expect(body).not.toContain(record.txid);
    expect(body).not.toContain('9876543210');
    expect(body).not.toContain('ABSECRET12CD');
    expect(body).toContain('AB********CD');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
