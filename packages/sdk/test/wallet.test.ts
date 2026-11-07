import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChallenge, createWallet } from '../src/index.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'oboro-wallet-'));
  const options = { tunnelUrl: 'http://127.0.0.1:7410', wallet: { pay: vi.fn() }, policy: { maxPerRequestZats: 5_000, dailyCapZats: 12_000, allowRecipients: ['merchant'] }, spendFile: join(dir, 'spend.json') };
  return { options, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
it('reports remaining budget from today’s persisted spend', async () => {
  const f = await fixture();
  try {
    await writeFile(f.options.spendFile, JSON.stringify({ day: new Date().toISOString().slice(0, 10), total: 7_000 }));
    expect(await createWallet(f.options).budget()).toEqual({ maxPerPaymentZats: 5_000, dailyCapZats: 12_000, spentTodayZats: 7_000, remainingTodayZats: 5_000 });
  } finally { await f.cleanup(); }
});
it('uses the gateway’s current commerce paths and request bodies', async () => {
  const f = await fixture(); const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ products: [], status: 'delivered', invoice_id: 'i', order_id: 'o' }), { status: 200 }); });
  try {
    const merchant = createWallet(f.options).merchant('merchant');
    await merchant.rules(); await merchant.search('gift card'); await merchant.product('a/b');
    await merchant.buy({ product_id: 'gift-card', value: '50', package_id: 'plan', phone_number: '+919876543210' });
    await merchant.receipt('receipt-id');
    expect(calls.map(c => c.url)).toEqual([
      'http://127.0.0.1:7410/nym/merchant/oboro/shop',
      'http://127.0.0.1:7410/nym/merchant/v1/shop/search?q=gift%20card',
      'http://127.0.0.1:7410/nym/merchant/v1/shop/product/a%2Fb',
      'http://127.0.0.1:7410/nym/merchant/v1/shop/buy',
      'http://127.0.0.1:7410/nym/merchant/v1/shop/receipt/receipt-id'
    ]);
    expect(calls[3].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[3].init?.body))).toEqual({ product_id: 'gift-card', value: '50', package_id: 'plan', phone_number: '+919876543210' });
  } finally { await f.cleanup(); }
});
it('returns approval as typed buy and receipt results', async () => {
  const f = await fixture();
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'needs_approval', approval_id: 'approval', receipt_id: 'receipt' }), { status: 202 }));
  try {
    const merchant = createWallet(f.options).merchant('merchant');
    expect(await merchant.buy({ product_id: 'gift-card', value: 50 })).toMatchObject({ status: 'needs_approval', approval_id: 'approval' });
    expect(await merchant.receipt('receipt')).toMatchObject({ status: 'needs_approval', approval_id: 'approval' });
  }
  finally { await f.cleanup(); }
});
it('preserves policy refusal before touching the payment wallet', async () => {
  const f = await fixture(); f.options.policy.allowRecipients = [];
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(buildChallenge('utest1merchant', '/v1/shop/buy', 5_000, 'purchase')), { status: 402 }));
  try { await expect(createWallet(f.options).merchant('merchant').buy({ product_id: 'gift-card', value: 50 })).rejects.toMatchObject({ code: 'policy_refused' }); expect(f.options.wallet.pay).not.toHaveBeenCalled(); }
  finally { await f.cleanup(); }
});
