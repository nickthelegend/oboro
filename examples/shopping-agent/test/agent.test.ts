import { describe, expect, it, vi } from 'vitest';
import { createShoppingAgent, type Complete, type ShopHandle } from '../agent.js';

const rules = { ledger: [], setup: [], today: { usd: 0, count: 0 }, guardrails: {
  allow: [{ product_id: 'swiggy-money-india', values: ['50'] }],
  maxUsdPerPurchase: 1, maxUsdPerDay: 10, maxPurchasesPerDay: 3,
} };
function fixture(usd = 0.5) {
  const buy = vi.fn(async () => ({ status: 'processing' as const, receipt_id: 'receipt-1', run_id: 'run-1' }));
  const shop: ShopHandle = {
    rules: vi.fn(async () => rules), search: vi.fn(async () => ({ products: [] })),
    product: vi.fn(async () => ({ id: 'swiggy-money-india', name: 'Swiggy', in_stock: true,
      currency: 'INR', packages: [{ value: '50', usd, currency: 'INR' }] })),
    buy, receipt: vi.fn(async () => ({ status: 'processing' as const, receipt_id: 'receipt-1' })),
    progress: vi.fn(() => ({ status: 'running', steps: [{ type: 'paying' }] })),
  };
  return { shop, buy };
}
const toolCall = (name: string, args: string) => ({ id: 'call-1', type: 'function' as const,
  function: { name, arguments: args } });
function model(name: string, args: string) {
  const complete = vi.fn<Complete>()
    .mockResolvedValueOnce({ role: 'assistant', content: null, tool_calls: [toolCall(name, args)] })
    .mockResolvedValue({ role: 'assistant', content: 'Done.' });
  return complete;
}
const budget = () => ({ maxPerPaymentZats: 50_000, dailyCapZats: 300_000,
  spentTodayZats: 0, remainingTodayZats: 300_000 });

describe('shopping example', () => {
  it('refuses an unlisted value before buy', async () => {
    const { shop, buy } = fixture();
    const agent = createShoppingAgent({ shop, budget, complete: model('buy',
      '{"product_id":"swiggy-money-india","value":"100"}') });
    const result = await agent.chat('', 'Buy the 100 value');
    expect(buy).not.toHaveBeenCalled();
    expect(result.turns.at(-1)?.tools?.[0]).toMatchObject({ ok: false, summary: 'package unavailable' });
  });
  it('parks an over-cap request only after owner confirmation', async () => {
    const { shop, buy } = fixture(2);
    const first = createShoppingAgent({ shop, budget, complete: model('buy',
      '{"product_id":"swiggy-money-india","value":"50","request_approval":true}') });
    const initial = await first.chat('', 'Buy the 50 value');
    expect(buy).not.toHaveBeenCalled();
    expect(initial.turns.at(-1)?.tools?.[0]?.summary).toContain('nothing paid');
    expect(initial.turns.at(-1)?.tools?.[0]?.summary).toContain('over the limit');
    const confirm = model('buy', '{"product_id":"swiggy-money-india","value":"50","request_approval":true}');
    const session = createShoppingAgent({ shop, budget, complete: vi.fn<Complete>()
      .mockResolvedValueOnce({ role: 'assistant', content: null, tool_calls: [toolCall('buy',
        '{"product_id":"swiggy-money-india","value":"50"}')] })
      .mockResolvedValueOnce({ role: 'assistant', content: 'Please confirm.' })
      .mockImplementation(confirm) });
    const asked = await session.chat('', 'Buy 50');
    await session.chat(asked.sessionId, 'Yes, go ahead anyway');
    expect(buy).toHaveBeenCalledTimes(1);
  });
  it('maps tool traces and run id', async () => {
    const { shop } = fixture();
    const agent = createShoppingAgent({ shop, budget, complete: model('buy',
      '{"product_id":"swiggy-money-india","value":"50"}') });
    const result = await agent.chat('', 'Buy 50');
    expect(result.turns.at(-1)).toMatchObject({ runId: 'run-1', tools: [
      { name: 'buy', args: { value: '50' }, ok: true },
    ] });
  });
  it('returns an unknown tool trace', async () => {
    const { shop } = fixture();
    const agent = createShoppingAgent({ shop, budget, complete: model('approve', '{}') });
    expect((await agent.chat('', 'approve')).turns.at(-1)?.tools?.[0])
      .toMatchObject({ name: 'approve', ok: false, summary: 'unknown tool' });
  });
  it('reports bad JSON args without calling shop', async () => {
    const { shop, buy } = fixture();
    const agent = createShoppingAgent({ shop, budget, complete: model('buy', '{bad') });
    expect((await agent.chat('', 'buy')).turns.at(-1)?.tools?.[0])
      .toMatchObject({ ok: false, summary: 'invalid JSON arguments' });
    expect(buy).not.toHaveBeenCalled();
  });
});
