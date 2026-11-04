import { describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { backoffMs, BitrefillClient, classify, DEFAULT_GUARDRAILS, Guardrails, maskCode, maskPhone, parseProduct, parseSearch, ShopLedger } from '../src/shop.js';

const fixtures = new URL('./fixtures/', import.meta.url);
const readFixture = async (name: string) => JSON.parse(await readFile(new URL(name, fixtures), 'utf8'));
describe('captured live catalog JSON', () => {
  it('parses actual CLI search and details', async () => {
    expect(parseSearch(await readFixture('airtel-search.json'))).toContainEqual({ id: 'airtel-india', name: 'Airtel India', in_stock: true, currency: 'INR' });
    const p = parseProduct(await readFixture('airtel-details.json'));
    expect(p.packages.find(x => x.value === '10')).toEqual({ value: '10', usd: 0.11, currency: 'INR' });
  });
});
describe('guardrails', () => {
  const product = { id: 'airtel-india', name: 'Airtel India', in_stock: true, currency: 'INR', packages: [{ value: '10', usd: 0.11, currency: 'INR' }] };
  const g = new Guardrails(DEFAULT_GUARDRAILS);
  it('allows the safe default', () => expect(g.check(product, 10, { usd: 0, count: 0 }).status).toBe('allowed'));
  it('refuses products outside allow list', () => expect(g.check({ ...product, id: 'other' }, 10, { usd: 0, count: 0 })).toEqual({ status: 'refused', reason: 'product_not_allowed' }));
  it('refuses values outside allow list', () => expect(g.check(product, 20, { usd: 0, count: 0 })).toEqual({ status: 'refused', reason: 'product_not_allowed' }));
  it('refuses out-of-stock', () => expect(g.check({ ...product, in_stock: false }, 10, { usd: 0, count: 0 })).toEqual({ status: 'refused', reason: 'out_of_stock' }));
  it('requires approval above per-purchase cap', () => expect(g.check({ ...product, packages: [{ value: '10', usd: 0.51, currency: 'INR' }] }, 10, { usd: 0, count: 0 })).toMatchObject({ status: 'needs_approval', reason: 'per_purchase_cap' }));
  it('requires approval above daily USD cap', () => expect(g.check(product, 10, { usd: 1.4, count: 0 })).toMatchObject({ status: 'needs_approval', reason: 'daily_usd_cap' }));
  it('requires approval above daily count', () => expect(g.check(product, 10, { usd: 0, count: 3 })).toMatchObject({ status: 'needs_approval', reason: 'daily_count_cap' }));
  it('uses catalog price, never a request price', () => expect(g.check(product, 10, { usd: 0, count: 0 })).toMatchObject({ usd: 0.11 }));
});
describe('ledger', () => {
  it('reserves atomically, rejects replay and stores only masks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oboro-shop-'));
    try {
      const file = join(dir, 'shop.json'); const ledger = new ShopLedger(file);
      const record = await ledger.reserve({ txid: 'a'.repeat(64), product_id: 'airtel-india', value: 10, usd: 0.11, phone_number: '+919876543210' });
      expect(record.status).toBe('reserved'); expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await ledger.today()).toEqual({ usd: 0.11, count: 1 });
      await expect(ledger.reserve({ txid: 'a'.repeat(64), product_id: 'airtel-india', value: 10, usd: 0.11 })).rejects.toMatchObject({ code: 'duplicate_txid' });
      await ledger.delivered('a'.repeat(64), { id: 'order1', status: 'delivered', redemption_info: { code: 'ABSECRET12CD', pin: '123456' } });
      const raw = await readFile(file, 'utf8'); expect(raw).not.toContain('9876543210'); expect(raw).not.toContain('ABSECRET12CD'); expect(raw).not.toContain('123456');
      expect((await ledger.byReceipt(record.receipt_id))?.code_masked?.code).toBe(maskCode('ABSECRET12CD'));
      expect((await readdir(dir)).filter(x => x.includes('.tmp'))).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('masks phones and codes', () => { expect(maskPhone('+919876543210')).toBe('********3210'); expect(maskCode('ABSECRET12CD')).toBe('AB********CD'); });
});
describe('status and retry', () => {
  const invoice = { id: 'i', status: 'complete', orders: [{ id: 'o', status: 'processing' }] };
  it('does not equate invoice complete with delivery', () => expect(classify(invoice, { id: 'o', status: 'processing' })).toBe('poll'));
  it.each(['failed', 'refunded'] as const)('recognises order %s', status => expect(classify(invoice, { id: 'o', status })).toBe(status));
  it.each(['blocked', 'denied', 'payment_error'] as const)('recognises invoice %s', status => expect(classify({ ...invoice, status }, { id: 'o', status: 'processing' })).toBe(status));
  it('recognises delivery', () => expect(classify(invoice, { id: 'o', status: 'delivered' })).toBe('delivered'));
  it('backs off exponentially with bounded jitter', () => { expect([0,1,2,3,4,5].map(i => backoffMs(i, 0))).toEqual([500,1000,2000,4000,8000,16000]); expect(backoffMs(5, 0.5)).toBe(16250); });
  it.skipIf(process.env.OBORO_BITREFILL_LIVE_BUY === '1')('does not create an invoice with live buying disabled', () => { const client = new BitrefillClient('key', 'https://unused.invalid'); expect(() => client.createInvoice({ products: [], payment_method: 'balance', auto_pay: true })).toThrowError('Setup required: OBORO_BITREFILL_LIVE_BUY=1'); });
  it('cannot bypass guardrails even if the live flag is set', () => { const old = process.env.OBORO_BITREFILL_LIVE_BUY; process.env.OBORO_BITREFILL_LIVE_BUY = '1'; try { const client = new BitrefillClient('key', 'https://unused.invalid'); expect(() => client.createInvoice({ products: [], payment_method: 'balance', auto_pay: true })).toThrowError('Invoice creation requires an approved, reserved purchase'); } finally { if (old === undefined) delete process.env.OBORO_BITREFILL_LIVE_BUY; else process.env.OBORO_BITREFILL_LIVE_BUY = old; } });
});
