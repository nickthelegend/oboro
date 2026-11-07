/**
 * A small shopping agent built on Oboro's merchant handle. It reads a gateway's live catalog and rules,
 * checks every package before spending, and leaves over-cap purchases for a human operator to approve.
 * The CLI supplies the real wallet SDK handle; the wallet app supplies the same handle plus progress events.
 */
import { randomUUID } from 'node:crypto';
import type {
  MerchantBuyInput, MerchantBuyResult, MerchantProduct, MerchantReceiptResult, MerchantRules, MerchantSearch,
  WalletBudget,
} from 'oboro';

export type ToolTrace = { name: string; args: Record<string, unknown>; summary: string; ok: boolean; mixMs?: number };
export type ChatTurn = { role: 'user' | 'assistant'; text: string; tools?: ToolTrace[]; runId?: string; at: string };
type Call = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type Message = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null;
  tool_calls?: Call[]; tool_call_id?: string };
export type Complete = (messages: Message[], tools: typeof TOOLS) => Promise<Message>;
type Purchase = MerchantBuyResult & { run_id?: string };
type Timed<T> = T & { mixMs?: number };
export type ShopHandle = {
  rules(): Promise<Timed<MerchantRules>>; search(query: string): Promise<Timed<MerchantSearch>>;
  product(id: string): Promise<Timed<MerchantProduct>>; buy(input: MerchantBuyInput): Promise<Purchase>;
  receipt(id: string): Promise<MerchantReceiptResult>;
  progress?(runId: string): { status: string; steps: { type: string }[];
    invoiceId?: string; error?: string } | undefined;
};
export type AgentOptions = { shop: ShopHandle;
  budget: () => Promise<WalletBudget & { balanceZats?: number }> | WalletBudget & { balanceZats?: number };
  complete?: Complete };

const SYSTEM = `You are an example shopping agent built on the Oboro wallet SDK. You shop through a merchant
 gateway over Nym. A shielded testnet Zcash payment authorises the gateway to buy from its store credits.
 First read shop_rules. Search and inspect live products; prices are USD and values use the product currency.
 Buy only when the owner asked for the exact product and value, it is sold, and it fits the caps.
 If over cap, explain that nothing is bought until the gateway operator approves. Only after the owner explicitly
 confirms an over-cap request may you set request_approval=true. You cannot approve it yourself.
 Purchases take minutes; report progress through check_purchase. Never ask for codes, cards or secrets.
 Reply in one to three short, concrete sentences of plain text (no markdown), with prices in ₹ and $.`;
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) =>
  ({ type: 'function' as const,
    function: { name, description, parameters: { type: 'object', properties, required } } });
const str = { type: 'string' };
export const TOOLS = [
  tool('shop_rules', 'Gateway rules, daily totals and wallet budget.'),
  tool('search_products', 'Search the live catalog.', { query: str }, ['query']),
  tool('get_product', 'Inspect live packages and rule verdicts.', { product_id: str }, ['product_id']),
  tool('buy', 'Start a shielded payment and purchase.',
    { product_id: str, value: str, request_approval: { type: 'boolean' } }, ['product_id', 'value']),
  tool('check_purchase', 'Read purchase progress.', { run_id: str }, ['run_id']),
];
type Rules = { allow: { product_id: string; values: (string | number)[] }[];
  maxUsdPerPurchase: number; maxUsdPerDay: number; maxPurchasesPerDay: number };
const idOk = (id: string) => /^[a-z0-9-]{1,100}$/.test(id);
const verdict = (rules: Rules, today: MerchantRules['today'], id: string, value: string, usd: number) => {
  const listed = rules.allow.some((a) => a.product_id === id && a.values.some((v) => String(v) === value));
  if (!listed) return 'not_sold_by_gateway';
  if (usd > rules.maxUsdPerPurchase || today.usd + usd > rules.maxUsdPerDay ||
      today.count >= rules.maxPurchasesPerDay) return 'needs_human_approval';
  return 'allowed';
};
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const confirmed = (text: string) => /\b(yes|confirm|go ahead|proceed|do it)\b/i.test(text);

async function openRouter(messages: Message[], tools: typeof TOOLS): Promise<Message> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('Setup required: OPENROUTER_API_KEY');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json',
      'X-Title': 'Oboro example shopping agent' },
    body: JSON.stringify({ model: process.env.OBORO_AGENT_MODEL ?? 'anthropic/claude-haiku-5.5',
      max_tokens: 1200, messages, tools, tool_choice: 'auto' }), signal: AbortSignal.timeout(90_000),
  });
  const body = await res.json() as { choices?: { message: Message }[]; error?: { message?: string } };
  if (!res.ok || !body.choices?.[0]) throw new Error(`Model error: ${body.error?.message ?? res.status}`);
  return body.choices[0].message;
}

export function createShoppingAgent({ shop, budget, complete = openRouter }: AgentOptions) {
  type Session = { messages: Message[]; turns: ChatTurn[]; confirmed?: boolean };
  const sessions = new Map<string, Session>();
  async function call(name: string, args: Record<string, unknown>, s: Session, turn: ChatTurn) {
    const trace = (summary: string, ok = true, mixMs?: number): ToolTrace => ({ name, args, summary, ok, mixMs });
    try {
      if (name === 'shop_rules') {
        const r = await shop.rules();
        return { result: { gateway: r.guardrails, today: r.today,
          wallet: { ...await budget(), costPerPurchaseZats: 5000 } },
          trace: trace(`${(r.guardrails as Rules).allow.length} products · ≤ $${(r.guardrails as Rules).maxUsdPerPurchase} each`) };
      }
      if (name === 'search_products') {
        const q = String(args.query ?? '').slice(0, 60);
        const r = await shop.search(q);
        return { result: r.products.slice(0, 8), trace: trace(`${r.products.length} results for “${q}”`, true, r.mixMs) };
      }
      if (name === 'get_product' || name === 'buy') {
        const id = String(args.product_id ?? '');
        if (!idOk(id)) return { result: { error: 'invalid product_id' }, trace: trace('invalid product id', false) };
        const [product, rules] = await Promise.all([shop.product(id), shop.rules()]);
        const packages = product.packages.map((p) => ({ ...p,
          rule: verdict(rules.guardrails as Rules, rules.today, id, String(p.value), p.usd) }));
        const ok = packages.filter((p) => p.rule === 'allowed').map((p) => p.value).join(', ') || 'none';
        if (name === 'get_product') return { result: { ...product, packages },
          trace: trace(`${product.name}: ${packages.length} packages · allowed ${ok}`, true, product.mixMs) };
        const value = String(args.value ?? '');
        const selected = packages.find((p) => String(p.value) === value);
        if (!selected || !product.in_stock) return { result: { refused: 'package unavailable' },
          trace: trace('package unavailable', false) };
        if (selected.rule === 'not_sold_by_gateway') return { result: { refused: selected.rule },
          trace: trace('not sold by gateway · nothing paid', false) };
        // Over a limit, code (not the model) checks that the owner's latest message is an explicit yes.
        if (selected.rule === 'needs_human_approval' && !(args.request_approval === true && s.confirmed)) {
          return { result: { refused: selected.rule, note: 'Nothing paid; ask the owner to confirm.' },
            trace: trace(`over the limit · $${selected.usd.toFixed(2)} · nothing paid`, false) };
        }
        const result = await shop.buy({ product_id: id, value });
        const runId = result.run_id ?? ('receipt_id' in result ? String(result.receipt_id) : undefined);
        if (runId) turn.runId = runId;
        return { result: { started: true, run_id: runId, status: result.status, usd: selected.usd },
          trace: trace(`${result.status} · ${id} ${value} · $${selected.usd.toFixed(2)}`) };
      }
      if (name === 'check_purchase') {
        const id = String(args.run_id ?? '');
        const p = shop.progress?.(id);
        const result = p ?? await shop.receipt(id);
        return { result, trace: trace(`purchase ${'status' in result ? result.status : 'unknown'}`) };
      }
      return { result: { error: 'unknown tool' }, trace: trace('unknown tool', false) };
    } catch (e) { return { result: { error: errorText(e) }, trace: trace(errorText(e), false) }; }
  }
  async function chat(sessionId: string, text: string): Promise<{ sessionId: string; turns: ChatTurn[] }> {
    const id = sessionId && sessions.has(sessionId) ? sessionId : randomUUID();
    const s = sessions.get(id) ?? { messages: [{ role: 'system', content: SYSTEM }], turns: [] };
    sessions.set(id, s);
    s.confirmed = confirmed(text);
    s.messages.push({ role: 'user', content: text.slice(0, 600) });
    s.turns.push({ role: 'user', text: text.slice(0, 600), at: new Date().toISOString() });
    const turn: ChatTurn = { role: 'assistant', text: '', tools: [], at: new Date().toISOString() };
    for (let i = 0; i < 6; i++) {
      const m = await complete(s.messages, TOOLS);
      s.messages.push({ role: 'assistant', content: m.content, tool_calls: m.tool_calls });
      if (!m.tool_calls?.length) { turn.text = (m.content ?? '').trim(); break; }
      for (const tc of m.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments || '{}');
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('bad arguments');
        } catch {
          const trace: ToolTrace = { name: tc.function.name, args: {}, summary: 'invalid JSON arguments', ok: false };
          turn.tools!.push(trace);
          s.messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: trace.summary }) });
          continue;
        }
        const outcome = await call(tc.function.name, args, s, turn);
        turn.tools!.push(outcome.trace);
        s.messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(outcome.result).slice(0, 4000) });
      }
    }
    if (!turn.text) turn.text = 'I ran out of steps on that one. Try asking again.';
    s.turns.push(turn);
    return { sessionId: id, turns: s.turns };
  }
  return { chat, turns: (id: string) => sessions.get(id)?.turns ?? [] };
}
