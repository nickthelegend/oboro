import { randomUUID } from 'node:crypto';
import type { CardCatalog, CardQuote, CardResult, WalletBudget } from 'oboro';

export type ToolTrace = { name: string; args: Record<string, unknown>; summary: string; ok: boolean; mixMs?: number };
export type ChatTurn = { role: 'user' | 'assistant'; text: string; tools?: ToolTrace[]; runId?: string; at: string };
type Call = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type Message = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: Call[]; tool_call_id?: string };
export type Complete = (messages: Message[], tools: typeof TOOLS) => Promise<Message>;
export type RelayHandle = { catalog(): Promise<CardCatalog>; quote(product_id: string, value: string | number): Promise<CardQuote>; buy(quote_id: string): Promise<CardResult>; receipt(receipt_id: string): Promise<CardResult> };
export type AgentOptions = { relay: RelayHandle; budget: () => Promise<WalletBudget> | WalletBudget; complete?: Complete };
const SYSTEM = `You are an example gift-card shopping agent. Read the relay catalog, then quote an exact product and value. Show its rupee value and live ZEC price before asking the owner to confirm. Only call buy after the owner explicitly says yes in their latest message. Never put a redemption code in your answer. Codes are saved outside the model context. Reply in short plain text.`;
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'function' as const, function: { name, description, parameters: { type: 'object', properties, required } } });
const str = { type: 'string' };
export const TOOLS = [
  tool('catalog', 'Show real gift cards, live ZEC rate, prices and limits.'),
  tool('quote', 'Quote a selected card and show its INR value and ZEC price.', { product_id: str, value: str }, ['product_id', 'value']),
  tool('buy', 'Pay for a previously quoted card only after explicit owner confirmation.', { quote_id: str }, ['quote_id']),
  tool('receipt', 'Check delivery status without revealing a code.', { receipt_id: str }, ['receipt_id']),
];
export const confirmed = (text: string) => /^\s*(?:yes\b|confirm\b|go ahead\b|proceed\b|do it\b)/i.test(text) && !/\b(?:no|not|don't|do not)\b/i.test(text);
const mask = (code?: Record<string, string>) => code && Object.fromEntries(Object.entries(code).map(([k, v]) => [k, v.length <= 8 ? '*'.repeat(v.length) : `${v.slice(0, 2)}${'*'.repeat(Math.min(12, v.length - 4))}${v.slice(-2)}`]));
const safe = (r: CardResult) => { const { code, ...rest } = r; return { ...rest, ...(code ? { code_masked: mask(code) } : {}) }; };
const err = (e: unknown) => e instanceof Error ? e.message : String(e);

async function openRouter(messages: Message[], tools: typeof TOOLS): Promise<Message> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('Setup required: OPENROUTER_API_KEY');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'X-Title': 'Oboro example shopping agent' }, body: JSON.stringify({ model: process.env.OBORO_AGENT_MODEL ?? 'anthropic/claude-haiku-5.5', max_tokens: 1200, messages, tools, tool_choice: 'auto' }), signal: AbortSignal.timeout(90_000) });
  const body = await res.json() as { choices?: { message: Message }[]; error?: { message?: string } };
  if (!res.ok || !body.choices?.[0]) throw new Error(`Model error: ${body.error?.message ?? res.status}`);
  return body.choices[0].message;
}
export function createShoppingAgent({ relay, budget, complete = openRouter }: AgentOptions) {
  type Session = { messages: Message[]; turns: ChatTurn[]; confirmed: boolean; quoted: Map<string, CardQuote>; presented: Set<string> };
  const sessions = new Map<string, Session>();
  async function call(name: string, args: Record<string, unknown>, s: Session, turn: ChatTurn) {
    const trace = (summary: string, ok = true): ToolTrace => ({ name, args, summary, ok });
    try {
      if (name === 'catalog') { const c = await relay.catalog(); return { result: { ...c, wallet: await budget() }, trace: trace(`${c.products.length} relay products`) }; }
      if (name === 'quote') {
        const id = String(args.product_id ?? ''), value = String(args.value ?? '');
        if (!/^[a-z0-9-]{1,100}$/.test(id) || !value) return { result: { error: 'invalid selection' }, trace: trace('invalid selection', false) };
        const q = await relay.quote(id, value); s.quoted.set(q.quote_id, q);
        return { result: q, trace: trace(`${q.name} ₹${q.value} · ${q.zats} zats at $${q.zec_usd}/ZEC`) };
      }
      if (name === 'buy') {
        const id = String(args.quote_id ?? ''), q = s.quoted.get(id);
        if (!q) return { result: { refused: 'quote_required' }, trace: trace('quote required', false) };
        if (!s.presented.has(id)) return { result: { refused: 'quote_must_be_shown_first' }, trace: trace('show the ZEC price and rupee value first', false) };
        if (!s.confirmed) return { result: { refused: 'explicit_confirmation_required', quote: { value: q.value, currency: q.currency, zats: q.zats } }, trace: trace(`ask for confirmation: ₹${q.value} · ${q.zats} zats`, false) };
        s.confirmed = false; const result = await relay.buy(id); turn.runId = result.receipt_id;
        return { result: safe(result), trace: trace(`${result.status} · ₹${q.value} · ${q.zats} zats`) };
      }
      if (name === 'receipt') { const r = await relay.receipt(String(args.receipt_id ?? '')); return { result: safe(r), trace: trace(`purchase ${r.status}`) }; }
      return { result: { error: 'unknown tool' }, trace: trace('unknown tool', false) };
    } catch (e) { return { result: { error: err(e) }, trace: trace(err(e), false) }; }
  }
  async function chat(sessionId: string, text: string): Promise<{ sessionId: string; turns: ChatTurn[] }> {
    const id = sessionId && sessions.has(sessionId) ? sessionId : randomUUID();
    const s = sessions.get(id) ?? { messages: [{ role: 'system' as const, content: SYSTEM }], turns: [], confirmed: false, quoted: new Map<string, CardQuote>(), presented: new Set<string>() };
    sessions.set(id, s); s.confirmed = confirmed(text);
    s.messages.push({ role: 'user', content: text.slice(0, 600) }); s.turns.push({ role: 'user', text: text.slice(0, 600), at: new Date().toISOString() });
    const turn: ChatTurn = { role: 'assistant', text: '', tools: [], at: new Date().toISOString() };
    for (let i = 0; i < 6; i++) {
      const m = await complete(s.messages, TOOLS); s.messages.push({ role: 'assistant', content: m.content, tool_calls: m.tool_calls });
      if (!m.tool_calls?.length) { turn.text = (m.content ?? '').trim(); break; }
      for (const tc of m.tool_calls) {
        let args: Record<string, unknown>;
        try { args = JSON.parse(tc.function.arguments || '{}'); if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error(); }
        catch { const t: ToolTrace = { name: tc.function.name, args: {}, summary: 'invalid JSON arguments', ok: false }; turn.tools!.push(t); s.messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: t.summary }) }); continue; }
        const outcome = await call(tc.function.name, args, s, turn); turn.tools!.push(outcome.trace); s.messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(outcome.result).slice(0, 4000) });
      }
    }
    if (!turn.text) turn.text = 'I ran out of steps on that one. Try asking again.';
    for (const q of s.quoted.values()) if (!s.presented.has(q.quote_id)) {
      turn.text += ` ₹${q.value} costs ${(q.zats / 1e8).toFixed(8)} ZEC (${q.zats} zats). Please confirm before I buy.`;
      s.presented.add(q.quote_id);
    }
    s.turns.push(turn); return { sessionId: id, turns: s.turns };
  }
  return { chat, turns: (id: string) => sessions.get(id)?.turns ?? [] };
}
