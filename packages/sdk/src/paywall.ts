import { OboroError } from './errors.js';
import { buildChallenge, decodePayment, type Challenge } from './protocol.js';
import { atomicJson, readJson } from './storage.js';
import type { Verification } from './verifier.js';
import { addressPrefix, networkFor, resolveChain, type Network } from './chain.js';

export interface LedgerEntry { ts: string; path: string; priceZats: number; txid?: string; height?: number; status: string; viaMixnet: boolean; sellerSaw: { ip: '127.0.0.1' | 'direct'; payerAddress: null } }
interface NonceState { path: string; priceZats: number; expiresAt: string; binding?: string; redeemedTxid?: string; claimedTxid?: string; claimedAt?: string }
// A challenge's expiresAt is the deadline to *submit* a payment. The first X-PAYMENT before it claims the nonce for that
// txid, and the same txid may keep retrying while the note is mined and seen (up to SETTLE_WINDOW_MS after the claim).
const SETTLE_WINDOW_MS = 2 * 60 * 60_000;
interface State { nonces: Record<string, NonceState>; txids: Record<string, string>; ledger: LedgerEntry[] }
export interface PaywallRequest { path: string; priceZats: number; description: string; paymentHeader?: string; viaMixnet: boolean; binding?: string; expiresAt?: string }
export type PaywallDecision = { authorized: true; headers: Record<string, string> } | { authorized: false; status: 402; body: Challenge | { error: string }; headers: Record<string, string> };
type Verifier = { find(txid: string, nonce: string, minZats: number): Promise<Verification> };
type RequestHandler = (req: { path: string; get(name: string): string | undefined }, res: { status(code: number): { json(body: unknown): void }; set(name: string, value: string): void }, next: (error?: unknown) => void) => void;
const denied = (error: string, headers: Record<string, string> = {}): PaywallDecision => ({ authorized: false, status: 402, body: { error }, headers });

export function createPaywall(options: { payTo: string; verifier: Verifier; stateFile: string; network: Network; verificationWaitMs?: number }) {
  if (options.network !== networkFor(resolveChain())) throw new OboroError('network_refused', 'Paywall network does not match OBORO_CHAIN');
  if (!options.payTo) throw new OboroError('setup_required', 'Setup required: OBORO_SELLER_ADDRESS');
  if (!options.payTo.startsWith(addressPrefix(options.network))) throw new OboroError('network_mismatch', 'Pay-to address does not match paywall network');
  if (!options.stateFile) throw new OboroError('setup_required', 'Setup required: paywall stateFile');
  let queue = Promise.resolve();
  const transact = <T>(fn: (state: State) => Promise<T> | T): Promise<T> => {
    const task = queue.then(async () => { const state = await readJson<State>(options.stateFile, { nonces: {}, txids: {}, ledger: [] }); const result = await fn(state); await atomicJson(options.stateFile, state); return result; });
    queue = task.then(() => undefined, () => undefined);
    return task;
  };
  // The core handles data only. The adapter below applies its decision to Express-compatible HTTP objects.
  async function authorize(input: PaywallRequest): Promise<PaywallDecision> {
    const { path, priceZats, description, paymentHeader, viaMixnet, binding, expiresAt } = input;
    if (!Number.isSafeInteger(priceZats) || priceZats <= 0) throw new OboroError('invalid_price', 'Invalid price');
    const base = { ts: new Date().toISOString(), path, priceZats, viaMixnet, sellerSaw: { ip: viaMixnet ? '127.0.0.1' : 'direct', payerAddress: null } } as const;
    if (!paymentHeader) {
      const deadline = expiresAt ? new Date(Math.min(Date.now() + 900_000, Date.parse(expiresAt))).toISOString() : undefined;
      if (deadline && Date.parse(deadline) <= Date.now()) return denied('quote_expired');
      const challenge = buildChallenge(options.payTo, path, priceZats, description, undefined, deadline, undefined, options.network);
      await transact(s => { s.nonces[challenge.accepts[0].extra.nonce] = { path, priceZats, binding, expiresAt: challenge.accepts[0].extra.expiresAt }; s.ledger.push({ ...base, status: 'payment_required' }); });
      return { authorized: false, status: 402, body: challenge, headers: {} };
    }
    let payment;
    try { payment = decodePayment(paymentHeader); } catch { return denied('payment_malformed'); }
    if (payment.network !== options.network) return denied('network_mismatch');
    const { txid, nonce } = payment.payload;
    const check = await transact(s => {
      const n = s.nonces[nonce];
      if (!n || n.path !== path) return 'nonce_unknown';
      if (n.binding !== binding) return 'nonce_binding_mismatch';
      if (n.priceZats !== priceZats) return 'nonce_unknown';
      if (n.redeemedTxid) return 'nonce_reused';
      if (s.txids[txid]) return 'txid_reused';
      if (n.claimedTxid && n.claimedTxid !== txid) return 'nonce_claimed';
      if (n.claimedTxid) return Date.now() - Date.parse(n.claimedAt ?? n.expiresAt) > SETTLE_WINDOW_MS ? 'settlement_window_closed' : null;
      if (Date.now() > Date.parse(n.expiresAt)) return 'nonce_expired';
      n.claimedTxid = txid; n.claimedAt = new Date().toISOString();
      return null;
    });
    if (check) {
      // Record the refusal against the txid, so a ledger never shows a refused payment as pending forever.
      if (check !== 'nonce_unknown') await transact(s => { s.ledger.push({ ...base, txid, status: check }); });
      return denied(check);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: Verification | undefined;
    try {
      result = await Promise.race<Verification | undefined>([
        options.verifier.find(txid, nonce, priceZats),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), options.verificationWaitMs ?? 8_000); })
      ]);
    } finally { if (timer) clearTimeout(timer); }
    const verification = result ?? { found: false, valueZats: 0, memo: '', height: 0, confirmations: 0 };
    let error: string | undefined;
    if (!verification.found || verification.confirmations < 1) error = 'payment_pending';
    else if (verification.memo !== `oboro:${nonce}`) error = 'payment_invalid_memo';
    else if (verification.valueZats < priceZats) error = 'payment_insufficient';
    if (error) {
      await transact(s => { s.ledger.push({ ...base, txid, height: verification.height || undefined, status: error }); });
      return denied(error, error === 'payment_pending' ? { 'Retry-After': '20' } : {});
    }
    const race = await transact(s => {
      if (s.nonces[nonce].redeemedTxid) return 'nonce_reused';
      if (s.txids[txid]) return 'txid_reused';
      s.nonces[nonce].redeemedTxid = txid; s.txids[txid] = nonce;
      s.ledger.push({ ...base, txid, height: verification.height, status: 'settled' });
      return null;
    });
    if (race) return denied(race);
    return { authorized: true, headers: { 'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, txid, network: options.network, height: verification.height })).toString('base64') } };
  }
  function price(priceZats: number, description: string): RequestHandler {
    if (!Number.isSafeInteger(priceZats) || priceZats <= 0) throw new OboroError('invalid_price', 'Invalid price');
    return async (req, res, next) => {
      try {
        const decision = await authorize({ path: req.path, priceZats, description, paymentHeader: req.get('X-PAYMENT'), viaMixnet: req.get('x-oboro-transport') === 'nym-mixnet' });
        for (const [name, value] of Object.entries(decision.headers)) res.set(name, value);
        if (decision.authorized) next(); else res.status(decision.status).json(decision.body);
      } catch (error) { next(error); }
    };
  }
  function priceFor(resolve: (req: { path: string; body?: any; get(name: string): string | undefined }) => Promise<{ zats: number; description: string; binding: string; expiresAt?: string }>): RequestHandler {
    return async (req, res, next) => {
      try {
        const price = await resolve(req);
        const decision = await authorize({ path: req.path, priceZats: price.zats, description: price.description, binding: price.binding, expiresAt: price.expiresAt, paymentHeader: req.get('X-PAYMENT'), viaMixnet: req.get('x-oboro-transport') === 'nym-mixnet' });
        for (const [name, value] of Object.entries(decision.headers)) res.set(name, value);
        if (decision.authorized) next(); else res.status(decision.status).json(decision.body);
      } catch (error) { next(error); }
    };
  }
  return { authorize, price, priceFor, ledger: async () => (await readJson<State>(options.stateFile, { nonces: {}, txids: {}, ledger: [] })).ledger };
}
