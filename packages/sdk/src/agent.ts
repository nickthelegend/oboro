import { join } from 'node:path';
import { OboroError } from './errors.js';
import { parseNymUrl } from './nym.js';
import { parseChallenge, encodePayment } from './protocol.js';
import { atomicJson, readJson } from './storage.js';

export type AgentEvent =
  | { type: 'request'; url: string } | { type: 'payment_required'; amountZats: number; payTo: string }
  | { type: 'policy_ok'; amountZats: number } | { type: 'policy_refused'; reason: string }
  | { type: 'paying'; amountZats: number } | { type: 'paid'; txid: string }
  | { type: 'pending'; txid: string } | { type: 'settled'; txid: string }
  | { type: 'response'; status: number; mixMs?: number };
interface Spend { day: string; total: number }
export interface AgentOptions {
  tunnelUrl: string; wallet: { pay(to: string, zats: number, memo: string): Promise<{txid: string}> };
  policy: { maxPerRequestZats: number; dailyCapZats: number; allowRecipients: string[] };
  onEvent?: (event: AgentEvent) => void; allowClearnet?: boolean; settleTimeoutMs?: number; spendFile?: string;
}
export function createAgent(options: AgentOptions) {
  if (!options.tunnelUrl) throw new OboroError('setup_required', 'Setup required: OBORO_TUNNEL_URL');
  const spendFile = options.spendFile ?? join(process.cwd(), '.oboro', 'agent-spend.json');
  const emit = (event: AgentEvent) => options.onEvent?.(event);
  async function spentToday(): Promise<number> { const s = await readJson<Spend>(spendFile, { day: '', total: 0 }); return s.day === new Date().toISOString().slice(0, 10) ? s.total : 0; }
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  async function fetchPaid(url: string, init: RequestInit = {}): Promise<Response> {
    emit({ type: 'request', url });
    let endpoint: string;
    let recipient: string;
    if (url.startsWith('nym://')) {
      const parsed = parseNymUrl(url);
      recipient = parsed.address;
      endpoint = `${options.tunnelUrl.replace(/\/$/, '')}/nym/${encodeURIComponent(parsed.address)}${parsed.path}${parsed.search}`;
    } else {
      if (!options.allowClearnet || !url.startsWith('https://')) throw new OboroError('clearnet_refused', 'Only nym:// URLs are allowed');
      endpoint = url; recipient = new URL(url).hostname;
    }
    const first = await globalThis.fetch(endpoint, init);
    if (first.status !== 402) { emit({ type: 'response', status: first.status, mixMs: Number(first.headers.get('x-oboro-mix-ms')) || undefined }); return first; }
    const challenge = parseChallenge(await first.json());
    const accept = challenge.accepts[0];
    if (accept.resource !== new URL(endpoint).pathname.replace(/^\/nym\/[^/]+/, '') && url.startsWith('nym://')) throw new OboroError('invalid_challenge', 'Challenge resource does not match request');
    const amount = Number(accept.maxAmountRequired);
    emit({ type: 'payment_required', amountZats: amount, payTo: accept.payTo });
    const spent = await spentToday();
    const reason = !options.policy.allowRecipients.includes(recipient) ? 'recipient not allowed' : amount > options.policy.maxPerRequestZats ? 'per-request cap exceeded' : spent + amount > options.policy.dailyCapZats ? 'daily cap exceeded' : Date.now() > Date.parse(accept.extra.expiresAt) ? 'challenge expired' : undefined;
    if (reason) { emit({ type: 'policy_refused', reason }); throw new OboroError('policy_refused', reason, false); }
    emit({ type: 'policy_ok', amountZats: amount });
    emit({ type: 'paying', amountZats: amount });
    const { txid } = await options.wallet.pay(accept.payTo, amount, accept.extra.memo);
    await atomicJson(spendFile, { day: new Date().toISOString().slice(0, 10), total: spent + amount });
    emit({ type: 'paid', txid });
    const deadline = Date.now() + (options.settleTimeoutMs ?? 900_000);
    const headers = new Headers(init.headers);
    headers.set('X-PAYMENT', encodePayment(txid, accept.extra.nonce));
    for (;;) {
      const response = await globalThis.fetch(endpoint, { ...init, headers });
      if (response.status !== 402) {
        if (response.ok) emit({ type: 'settled', txid });
        emit({ type: 'response', status: response.status, mixMs: Number(response.headers.get('x-oboro-mix-ms')) || undefined });
        return response;
      }
      const body = await response.json() as {error?: string};
      if (body.error !== 'payment_pending') throw new OboroError(body.error ?? 'payment_rejected', `Payment rejected: ${body.error ?? 'unknown'}`, true);
      emit({ type: 'pending', txid });
      if (Date.now() >= deadline) throw new OboroError('settlement_timeout', 'Payment settlement timed out', true);
      await wait(Math.min(20_000, Math.max(0, deadline - Date.now())));
    }
  }
  return { fetch: fetchPaid, spentToday, policy: options.policy };
}
