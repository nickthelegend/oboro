// agent wallet's brain: an LLM (OpenRouter, model from OBORO_AGENT_MODEL) with tools that only reach the world through Oboro.
// Every tool talks to gateway over the Nym mixnet; the only way to spend is buy(), which pays gateway in shielded ZEC and
// lets gateway's guardrails decide. The model never sees a wallet key, a Bitrefill key or an unmasked code.
import { randomUUID } from 'node:crypto';

export type ToolTrace = { name: string; args: Record<string, unknown>; summary: string; ok: boolean; mixMs?: number };
export type ChatTurn = { role: 'user' | 'assistant'; text: string; tools?: ToolTrace[]; runId?: string; at: string };
type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; tool_call_id?: string };

export interface AgentDeps {
  viaNym: (path: string) => Promise<{ status: number; body: Record<string, unknown>; mixMs: number }>;
  launchShopRun: (productId: string, value: string) => Promise<{ run?: { id: string }; status: number; error?: string }>;
  shopRun: (id: string) => { status: string; steps: { type: string; detail?: string }[]; invoiceId?: string; error?: string; txid?: string } | undefined;
  budget: () => { balanceZats?: number; spentTodayZats: number; dailyCapZats: number; maxPerRequestZats: number };
}

const SYSTEM = `You are the user's agent, which pays and shops only through its Oboro wallet.
You have no Bitrefill account, no card and no exposed IP. Your tools reach the merchant gateway over the Nym mixnet.
To buy, your Oboro wallet pays the merchant gateway 5,000 zatoshis of shielded testnet Zcash; that payment
authorises the merchant gateway to buy the item from its Bitrefill store credits, inside the gateway's published rules.
How to work:
- First call shop_rules to learn what gateway is allowed to sell and the caps. Use search_products and get_product to find
  real items and prices. Prices are in USD from Bitrefill; values are in the product's currency (₹ for India).
- Only call buy when the owner clearly asked to buy, the exact product and value are allowed, and it fits the caps.
  If something isn't sold or is above the cap, don't buy it: say so plainly and offer an allowed option.
- Above the cap (rule "needs_human_approval"): explain that gateway's operator must approve it. Only if the owner then
  explicitly says to go ahead anyway, call buy with request_approval=true: you pay, gateway parks the purchase, and
  nothing is bought until a human on gateway's side approves. You can never approve anything yourself.
- A purchase takes a few minutes (the payment must be mined). After buy starts it, say that it's running and that
  progress shows in the panel. Use check_purchase if asked how it's going.
- Codes are cash: you never see them and never ask for them. Never ask for card numbers, passwords or personal data.
Reply in 1 to 3 short sentences, friendly and concrete, with prices in both ₹ and $ when you quote.`;

const TOOLS = [
  { type: 'function', function: { name: 'shop_rules', description: "gateway's published shop rules: allowed products and values, per-purchase and daily caps, today's totals; plus agent wallet's own wallet budget.", parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'search_products', description: "Search gateway's Bitrefill catalog (India) over the Nym mixnet.", parameters: { type: 'object', properties: { query: { type: 'string', description: 'e.g. "swiggy", "google play", "uber"' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'get_product', description: 'Live packages and USD prices for one product, each marked allowed / needs_human_approval / not_sold_by_gateway under the rules.', parameters: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] } } },
  { type: 'function', function: { name: 'buy', description: 'Pay gateway in shielded ZEC over Nym to buy one allowed product value. Starts the purchase and returns immediately.', parameters: { type: 'object', properties: { product_id: { type: 'string' }, value: { type: 'string', description: 'package value exactly as listed, e.g. "50"' }, request_approval: { type: 'boolean', description: "Only after the owner explicitly confirmed an over-cap purchase: submit it for human approval on gateway's side." } }, required: ['product_id', 'value'] } } },
  { type: 'function', function: { name: 'check_purchase', description: 'Status of a purchase started with buy.', parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] } } },
];

type Rules = { allow: { product_id: string; values: (string | number)[] }[]; maxUsdPerPurchase: number; maxUsdPerDay: number; maxPurchasesPerDay: number };

export function createChatAgent(deps: AgentDeps) {
  const sessions = new Map<string, { msgs: Msg[]; turns: ChatTurn[] }>();
  let rulesCache: { at: number; rules?: Rules; today?: { usd: number; count: number } } = { at: 0 };

  async function rules() {
    if (Date.now() - rulesCache.at < 30_000 && rulesCache.rules) return rulesCache;
    const r = await deps.viaNym('/oboro/shop');
    if (r.status !== 200) throw new Error(`gateway's rules unavailable (HTTP ${r.status})`);
    rulesCache = { at: Date.now(), rules: r.body.guardrails as Rules, today: r.body.today as { usd: number; count: number } };
    return rulesCache;
  }
  const verdict = (rl: Rules, today: { usd: number; count: number } | undefined, id: string, value: string, usd: number) => {
    const a = rl.allow.find((x) => x.product_id === id);
    if (!a || !a.values.some((v) => String(v) === value)) return 'not_sold_by_gateway';
    if (usd > rl.maxUsdPerPurchase) return 'needs_human_approval';
    if (today && (today.usd + usd > rl.maxUsdPerDay || today.count >= rl.maxPurchasesPerDay)) return 'needs_human_approval';
    return 'allowed';
  };

  async function call(name: string, args: Record<string, unknown>, turn: ChatTurn): Promise<{ result: unknown; trace: ToolTrace }> {
    const t = (summary: string, ok = true, mixMs?: number): ToolTrace => ({ name, args, summary, ok, mixMs });
    try {
      if (name === 'shop_rules') {
        const r = await rules(); const b = deps.budget();
        return { result: { gateway: r.rules, today: r.today, wallet: { balanceZats: b.balanceZats, spentTodayZats: b.spentTodayZats, dailyCapZats: b.dailyCapZats, costPerPurchaseZats: 5000 } }, trace: t(`${r.rules?.allow.length ?? 0} products allowed · ≤ $${r.rules?.maxUsdPerPurchase} each · $${r.rules?.maxUsdPerDay}/day`) };
      }
      if (name === 'search_products') {
        const q = String(args.query ?? '').slice(0, 60);
        const r = await deps.viaNym(`/v1/shop/search?q=${encodeURIComponent(q)}`);
        const list = ((r.body.products as { id: string; name: string; in_stock: boolean }[]) ?? []).slice(0, 8);
        return { result: list, trace: t(`${list.length} results for “${q}”`, r.status === 200, r.mixMs) };
      }
      if (name === 'get_product') {
        const id = String(args.product_id ?? '');
        if (!/^[a-z0-9-]{1,100}$/.test(id)) return { result: { error: 'invalid product_id' }, trace: t('invalid product id', false) };
        const [r, rr] = await Promise.all([deps.viaNym(`/v1/shop/product/${id}`), rules()]);
        if (r.status !== 200) return { result: { error: r.body.error ?? `HTTP ${r.status}` }, trace: t(`not found: ${id}`, false, r.mixMs) };
        const pk = ((r.body.packages as { value: string; usd: number; currency: string }[]) ?? []).map((p) => ({ ...p, rule: verdict(rr.rules!, rr.today, id, String(p.value), p.usd) }));
        const ok = pk.filter((p) => p.rule === 'allowed').map((p) => `₹${p.value}`);
        return { result: { id, name: r.body.name, in_stock: r.body.in_stock, packages: pk }, trace: t(`${r.body.name}: ${pk.length} packages · allowed ${ok.join(', ') || 'none'}`, true, r.mixMs) };
      }
      if (name === 'buy') {
        const id = String(args.product_id ?? ''); const value = String(args.value ?? '');
        const [r, rr] = await Promise.all([deps.viaNym(`/v1/shop/product/${id}`), rules()]);
        const p = ((r.body.packages as { value: string; usd: number }[]) ?? []).find((x) => String(x.value) === value);
        if (!p) return { result: { refused: `No ${value} package for ${id}` }, trace: t(`refused: no ${value} package`, false) };
        const v = verdict(rr.rules!, rr.today, id, value, p.usd);
        // agent wallet checks the seller's published rules before paying, so a refused purchase never costs a payment.
        const parked = v === 'needs_human_approval' && args.request_approval === true;
        if (v !== 'allowed' && !parked) return { result: { refused: v, usd: p.usd, note: v === 'needs_human_approval' ? 'Above the cap: nothing paid, nothing bought. A human approves out of band.' : 'gateway does not sell this value.' }, trace: t(`${v.replace(/_/g, ' ')} · $${p.usd.toFixed(2)} · nothing paid`, false) };
        const launched = await deps.launchShopRun(id, value);
        if (!launched.run) return { result: { error: launched.error }, trace: t(launched.error ?? 'could not start', false) };
        turn.runId = launched.run.id;
        if (parked) return { result: { started: true, run_id: launched.run.id, usd: p.usd, note: 'Over the cap: paying gateway 5,000 zats; gateway parks it and buys nothing until its human operator approves.' }, trace: t(`submitted for human approval · ${id} ₹${value} · $${p.usd.toFixed(2)}`) };
        return { result: { started: true, run_id: launched.run.id, usd: p.usd, note: 'Paying gateway 5,000 zats shielded over Nym; Bitrefill delivers after the block is mined (a few minutes).' }, trace: t(`started · ${id} ₹${value} · $${p.usd.toFixed(2)}`) };
      }
      if (name === 'check_purchase') {
        const run = deps.shopRun(String(args.run_id ?? ''));
        if (!run) return { result: { error: 'unknown run' }, trace: t('unknown run', false) };
        const last = run.steps[run.steps.length - 1];
        return { result: { status: run.status, last_step: last?.type, invoice_id: run.invoiceId, error: run.error }, trace: t(`${run.status}${run.invoiceId ? ` · invoice ${run.invoiceId.slice(0, 8)}…` : ''}`) };
      }
      return { result: { error: 'unknown tool' }, trace: t('unknown tool', false) };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { result: { error: m }, trace: t(m, false) };
    }
  }

  async function llm(msgs: Msg[]): Promise<Msg> {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error('Setup required: OPENROUTER_API_KEY');
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'X-Title': 'Oboro agent wallet' },
      body: JSON.stringify({ model: process.env.OBORO_AGENT_MODEL ?? 'anthropic/claude-haiku-5.5', max_tokens: 500, messages: msgs, tools: TOOLS, tool_choice: 'auto' }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await res.json().catch(() => ({}))) as { choices?: { message: Msg }[]; error?: { message?: string } };
    if (!res.ok || !body.choices?.[0]) throw new Error(`Model error: ${body.error?.message ?? res.status}`);
    return body.choices[0].message;
  }

  async function chat(sessionId: string, text: string): Promise<{ sessionId: string; turns: ChatTurn[] }> {
    const id = sessionId && sessions.has(sessionId) ? sessionId : randomUUID();
    const s = sessions.get(id) ?? { msgs: [{ role: 'system', content: SYSTEM }], turns: [] };
    sessions.set(id, s);
    s.msgs.push({ role: 'user', content: text.slice(0, 600) });
    s.turns.push({ role: 'user', text: text.slice(0, 600), at: new Date().toISOString() });
    const turn: ChatTurn = { role: 'assistant', text: '', tools: [], at: new Date().toISOString() };
    for (let i = 0; i < 6; i++) {
      const m = await llm(s.msgs);
      s.msgs.push({ role: 'assistant', content: m.content ?? null, tool_calls: m.tool_calls });
      if (!m.tool_calls?.length) { turn.text = (m.content ?? '').trim(); break; }
      for (const tc of m.tool_calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* model sent bad JSON; tool reports it */ }
        const { result, trace } = await call(tc.function.name, args, turn);
        turn.tools!.push(trace);
        s.msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 4000) });
      }
    }
    if (!turn.text) turn.text = 'I ran out of steps on that one. Try asking again, more specifically.';
    s.turns.push(turn);
    return { sessionId: id, turns: s.turns };
  }
  return { chat, turns: (id: string) => sessions.get(id)?.turns ?? [] };
}
