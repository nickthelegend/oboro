import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/index.js';

it('exposes paywall pricing and a readable ledger', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oboro-gateway-'));
  try {
    const gateway = createGateway({ payTo: 'utest1merchant', stateFile: join(dir, 'state.json'), network: 'zcash-testnet', verifier: { find: async () => ({ found: false, valueZats: 0, memo: '', height: 0, confirmations: 0 }) } });
    expect(await gateway.ledger()).toEqual([]);
    const handler = gateway.price(5_000, 'purchase');
    let status = 0; let body: any;
    const res = { status(n: number) { status = n; return this; }, json(v: unknown) { body = v; }, set() {} };
    await handler({ path: '/v1/shop/buy', get: () => undefined }, res, () => {});
    expect(status).toBe(402);
    expect(body.accepts[0].maxAmountRequired).toBe('5000');
    expect((await gateway.ledger())[0]).toMatchObject({ path: '/v1/shop/buy', priceZats: 5_000, status: 'payment_required' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
