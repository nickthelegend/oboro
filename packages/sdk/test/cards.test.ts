import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChallenge, createWallet, oneTimeKey, openSeal, seal } from '../src/index.js';
import { createCards } from '../src/cards.js';
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
it('seals a code for one X25519 key and rejects another', () => {
  const a = oneTimeKey(), b = oneTimeKey();
  const box = seal({ code: 'ABSECRET12CD' }, a.publicKey);
  expect(openSeal(box, a.privateKey)).toEqual({ code: 'ABSECRET12CD' });
  expect(() => openSeal(box, b.privateKey)).toThrow();
});
it('passes a recharge phone number to the paid buy request and returns its masked receipt', async () => {
  const fetchPaid = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({ quote_id: 'a'.repeat(48), phone_number: '+919876543283' });
    return new Response(JSON.stringify({ status: 'delivered', kind: 'recharge', receipt_id: 'b'.repeat(48), phone_masked: '••83', amount: 299, value: '1.5GB/Day – 28 Days' }));
  });
  const result = await createCards(fetchPaid, 'merchant').buy('a'.repeat(48), { phoneNumber: '+919876543283' });
  expect(result).toMatchObject({ kind: 'recharge', phone_masked: '••83', amount: 299 });
  expect(result.code).toBeUndefined();
  expect(fetchPaid).toHaveBeenCalledTimes(1);
});
it('preserves wallet policy for a real-priced quote over its cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oboro-card-policy-'));
  const pay = vi.fn();
  globalThis.fetch = vi.fn(async (url) => new Response(JSON.stringify(String(url).endsWith('/quote')
    ? { quote_id: 'a'.repeat(48), usd: 3, zats: 1_000_000 }
    : buildChallenge('utest1merchant', '/v1/cards/buy', 1_000_000, 'Blinkit INR 250 at 300 USD/ZEC')), { status: String(url).endsWith('/quote') ? 200 : 402 }));
  try {
    const cards = createWallet({ tunnelUrl: 'http://127.0.0.1:7410', wallet: { pay }, policy: { maxPerRequestZats: 500_000, dailyCapZats: 2_000_000, allowRecipients: ['merchant'] }, spendFile: join(dir, 'spend.json') }).cards('merchant');
    const q = await cards.quote('blink-it-india', 250);
    await expect(cards.buy(q.quote_id)).rejects.toMatchObject({ code: 'policy_refused' });
    expect(pay).not.toHaveBeenCalled();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
