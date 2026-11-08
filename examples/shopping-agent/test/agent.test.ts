import { expect, it, vi } from 'vitest';
import { confirmed, createShoppingAgent, type Complete, type RelayHandle } from '../agent.js';
const q = { quote_id: 'a'.repeat(48), product_id: 'blink-it-india', name: 'Blinkit', value: '250', currency: 'INR', usd: 3, zec_usd: 300, rate_source: 'kraken', zats: 1_000_000, created_at: '', expires_at: '' };
const budget = () => ({ maxPerPaymentZats: 2_000_000, dailyCapZats: 4_000_000, spentTodayZats: 0, remainingTodayZats: 4_000_000 });
const call = (name: string, args: string) => ({ id: 'one', type: 'function' as const, function: { name, arguments: args } });
const model = (name: string, args: string) => vi.fn<Complete>().mockResolvedValueOnce({ role: 'assistant', content: null, tool_calls: [call(name, args)] }).mockResolvedValue({ role: 'assistant', content: 'Done.' });
function fixture() {
  const buy = vi.fn(async () => ({ status: 'delivered', receipt_id: 'b'.repeat(48), code: { code: 'ABSECRET12CD' } }));
  const relay: RelayHandle = { catalog: vi.fn(async () => ({ rate: { usd: 300, source: 'kraken', at: '' }, float_usd: 8.74, limits: { max_usd_per_sale: 6, max_usd_per_day: 9, sold_today_usd: 0 }, products: [], setup: [] })), quote: vi.fn(async () => q), buy, receipt: vi.fn(async () => ({ status: 'delivered', receipt_id: 'b'.repeat(48), code: { code: 'ABSECRET12CD' } })) };
  return { relay, buy };
}
it('quotes the rupee value and real ZEC price', async () => {
  const { relay } = fixture(); const a = createShoppingAgent({ relay, budget, complete: model('quote', '{"product_id":"blink-it-india","value":"250"}') });
  const turn = (await a.chat('', 'Quote Blinkit 250')).turns.at(-1);
  expect(turn?.tools?.[0]?.summary).toContain('₹250 · 1000000 zats');
  expect(turn?.text).toContain('₹250 costs 0.01000000 ZEC');
});
it('does not buy in the same turn that first presents a quote', async () => {
  const { relay, buy } = fixture();
  const complete = vi.fn<Complete>().mockResolvedValueOnce({ role: 'assistant', content: null, tool_calls: [call('quote', '{"product_id":"blink-it-india","value":"250"}')] }).mockResolvedValueOnce({ role: 'assistant', content: null, tool_calls: [call('buy', `{"quote_id":"${q.quote_id}"}`)] }).mockResolvedValue({ role: 'assistant', content: 'Done.' });
  const a = createShoppingAgent({ relay, budget, complete }); const result = await a.chat('', 'Yes, buy Blinkit 250');
  expect(result.turns.at(-1)?.tools?.[1]).toMatchObject({ ok: false, summary: 'show the ZEC price and rupee value first' });
  expect(buy).not.toHaveBeenCalled();
});
it('refuses buy without a prior quote', async () => {
  const { relay, buy } = fixture(); const a = createShoppingAgent({ relay, budget, complete: model('buy', `{"quote_id":"${q.quote_id}"}`) });
  expect((await a.chat('', 'Buy it')).turns.at(-1)?.tools?.[0]).toMatchObject({ ok: false, summary: 'quote required' }); expect(buy).not.toHaveBeenCalled();
});
it('requires explicit yes in the latest owner message', async () => {
  const { relay, buy } = fixture(); const complete = vi.fn<Complete>().mockResolvedValueOnce({ role: 'assistant', content: null, tool_calls: [call('quote', '{"product_id":"blink-it-india","value":"250"}')] }).mockResolvedValueOnce({ role: 'assistant', content: '₹250 costs 1000000 zats. Confirm?' }).mockResolvedValueOnce({ role: 'assistant', content: null, tool_calls: [call('buy', `{"quote_id":"${q.quote_id}"}`)] }).mockResolvedValue({ role: 'assistant', content: 'Done.' });
  const a = createShoppingAgent({ relay, budget, complete }); const first = await a.chat('', 'Buy Blinkit 250'); expect(buy).not.toHaveBeenCalled();
  await a.chat(first.sessionId, 'Yes, go ahead'); expect(buy).toHaveBeenCalledTimes(1);
});
it('masks code in model tool output', async () => {
  const { relay } = fixture(); const complete = vi.fn<Complete>().mockResolvedValueOnce({ role: 'assistant', content: null, tool_calls: [call('receipt', '{"receipt_id":"r"}')] }).mockResolvedValue({ role: 'assistant', content: 'Done.' });
  const a = createShoppingAgent({ relay, budget, complete }); await a.chat('', 'Check receipt');
  expect(JSON.stringify(complete.mock.calls)).not.toContain('ABSECRET12CD'); expect(JSON.stringify(complete.mock.calls)).toContain('AB********CD');
});
it('reports bad JSON without buying', async () => {
  const { relay, buy } = fixture(); const a = createShoppingAgent({ relay, budget, complete: model('buy', '{bad') });
  expect((await a.chat('', 'buy')).turns.at(-1)?.tools?.[0]).toMatchObject({ ok: false, summary: 'invalid JSON arguments' }); expect(buy).not.toHaveBeenCalled();
});
it('does not mistake a negated yes for owner consent', () => { expect(confirmed('Do not buy it, even if I say yes')).toBe(false); expect(confirmed('Yes, do not buy')).toBe(false); expect(confirmed('Yes, go ahead')).toBe(true); });
