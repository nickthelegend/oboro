import { createAgent, type AgentOptions } from './agent.js';
import { createCards } from './cards.js';

export interface WalletBudget {
  maxPerPaymentZats: number;
  dailyCapZats: number;
  spentTodayZats: number;
  remainingTodayZats: number;
}
export type ApprovalResult = { status: 'needs_approval'; approval_id: string; receipt_id?: string; [key: string]: unknown };
export type MerchantBuyResult = ApprovalResult | { status: 'processing'; receipt_id: string; [key: string]: unknown } | { status: 'delivered'; invoice_id: string; order_id: string; [key: string]: unknown };
export type MerchantReceiptResult = ApprovalResult
  | { status: 'processing'; receipt_id: string; [key: string]: unknown }
  | { status: 'delivered'; invoice_id?: string; order_id?: string; [key: string]: unknown }
  | { status: 'reserved' | 'expired' | 'failed' | 'refunded' | 'blocked' | 'denied' | 'payment_error'; [key: string]: unknown };
export type MerchantRules = { ledger: unknown[]; guardrails: Record<string, unknown>; today: { usd: number; count: number }; setup: string[] };
export type MerchantSearch = { products: { id: string; name: string; in_stock: boolean; currency: string }[] };
export type MerchantProduct = { id: string; name: string; in_stock: boolean; currency: string; packages: { value: string; usd: number; currency: string }[] };
export type MerchantBuyInput = { product_id: string; value: string | number; package_id?: string; phone_number?: string };

export function createWallet(options: AgentOptions) {
  const agent = createAgent(options);
  async function budget(): Promise<WalletBudget> {
    const spentTodayZats = await agent.spentToday();
    return {
      maxPerPaymentZats: agent.policy.maxPerRequestZats,
      dailyCapZats: agent.policy.dailyCapZats,
      spentTodayZats,
      remainingTodayZats: Math.max(0, agent.policy.dailyCapZats - spentTodayZats)
    };
  }
  function merchant(nymAddress: string) {
    const root = `nym://${nymAddress}`;
    const get = async <T>(path: string): Promise<T> => {
      const response = await agent.fetch(`${root}${path}`);
      if (!response.ok) throw new Error(`Merchant gateway answered HTTP ${response.status}`);
      return response.json() as Promise<T>;
    };
    return {
      rules: () => get<MerchantRules>('/oboro/shop'),
      search: (q: string) => get<MerchantSearch>(`/v1/shop/search?q=${encodeURIComponent(q)}`),
      product: (id: string) => get<MerchantProduct>(`/v1/shop/product/${encodeURIComponent(id)}`),
      buy: async (input: MerchantBuyInput): Promise<MerchantBuyResult> => {
        const response = await agent.fetch(`${root}/v1/shop/buy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
        if (!response.ok && response.status !== 202) throw new Error(`Merchant gateway answered HTTP ${response.status}`);
        return response.json() as Promise<MerchantBuyResult>;
      },
      receipt: (id: string) => get<MerchantReceiptResult>(`/v1/shop/receipt/${encodeURIComponent(id)}`)
    };
  }
  return { ...agent, budget, merchant, cards: (relayNymAddress: string) => createCards(agent.fetch, relayNymAddress) };
}
