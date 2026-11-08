import { expect, it } from 'vitest';
import type { Express } from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BitrefillClient, Relay, RelayLedger } from '@oboro/shop';
import { mountRelay } from './relay-routes.js';
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
