import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaywall, encodePayment } from '../src/index.js';
const txid = 'b'.repeat(64);
const txid2 = 'c'.repeat(64);
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'oboro-paywall-'));
  const stateFile = join(dir, 'state.json');
  let result = { found: true, valueZats: 2000, memo: '', height: 100, confirmations: 2 };
  const wall = createPaywall({ payTo: 'utest1seller', stateFile, network: 'zcash-testnet', verifier: { find: async () => result } });
  const call = async (header?: string, path = '/tip') => {
    let status = 200; let body: any; const headers: Record<string, string> = {}; let next = false;
    const req = { path, get: (name: string) => name === 'X-PAYMENT' ? header : name === 'x-oboro-transport' ? 'nym-mixnet' : undefined };
    const res = { status: (code: number) => { status = code; return res; }, json: (value: unknown) => { body = value; }, set: (name: string, value: string) => { headers[name] = value; } };
    await wall.price(2000, 'tip')(req, res, () => { next = true; });
    return { status, body, headers, next };
  };
  return { wall, call, stateFile, setResult: (v: typeof result) => { result = v; }, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
describe('paywall replay and verification state machine (unit only)', () => {
  it('exposes a framework-agnostic authorization decision', async () => { const f = await fixture(); const decision = await f.wall.authorize({ path: '/tip', priceZats: 2000, description: 'tip', viaMixnet: true }); expect(decision).toMatchObject({ authorized: false, status: 402, body: { error: 'payment_required' } }); await f.cleanup(); });
  it('issues an exact x402 challenge and records mixnet metadata', async () => { const f = await fixture(); const r = await f.call(); expect(r.status).toBe(402); expect(r.body.accepts[0].maxAmountRequired).toBe('2000'); expect((await f.wall.ledger())[0]).toMatchObject({ viaMixnet: true, sellerSaw: { ip: '127.0.0.1', payerAddress: null } }); await f.cleanup(); });
  it('redeems a confirmed transfer once', async () => { const f = await fixture(); const challenge = (await f.call()).body; const nonce = challenge.accepts[0].extra.nonce; f.setResult({ found: true, valueZats: 2000, memo: `oboro:${nonce}`, height: 100, confirmations: 2 }); const header = encodePayment(txid, nonce); const paid = await f.call(header); expect(paid.next).toBe(true); expect(paid.headers['X-PAYMENT-RESPONSE']).toBeTruthy(); expect((await f.call(header)).body.error).toBe('nonce_reused'); await f.cleanup(); });
  it('rejects reuse of a txid with a different nonce', async () => { const f = await fixture(); const first = (await f.call()).body.accepts[0].extra.nonce; f.setResult({ found: true, valueZats: 2000, memo: `oboro:${first}`, height: 100, confirmations: 2 }); await f.call(encodePayment(txid, first)); const second = (await f.call()).body.accepts[0].extra.nonce; expect((await f.call(encodePayment(txid, second))).body.error).toBe('txid_reused'); await f.cleanup(); });
  it('rejects expired nonce', async () => { const f = await fixture(); const nonce = (await f.call()).body.accepts[0].extra.nonce; const state = JSON.parse(await readFile(f.stateFile, 'utf8')); state.nonces[nonce].expiresAt = '2000-01-01T00:00:00.000Z'; await writeFile(f.stateFile, JSON.stringify(state)); expect((await f.call(encodePayment(txid, nonce))).body.error).toBe('nonce_expired'); await f.cleanup(); });
  it('lets a txid submitted before expiry settle after it', async () => { const f = await fixture(); const nonce = (await f.call()).body.accepts[0].extra.nonce; f.setResult({ found: false, valueZats: 0, memo: '', height: 0, confirmations: 0 }); expect((await f.call(encodePayment(txid, nonce))).body.error).toBe('payment_pending'); const state = JSON.parse(await readFile(f.stateFile, 'utf8')); state.nonces[nonce].expiresAt = '2000-01-01T00:00:00.000Z'; await writeFile(f.stateFile, JSON.stringify(state)); f.setResult({ found: true, valueZats: 2000, memo: `oboro:${nonce}`, height: 100, confirmations: 2 }); expect((await f.call(encodePayment(txid, nonce))).next).toBe(true); await f.cleanup(); });
  it('refuses a second txid for a claimed nonce', async () => { const f = await fixture(); const nonce = (await f.call()).body.accepts[0].extra.nonce; f.setResult({ found: false, valueZats: 0, memo: '', height: 0, confirmations: 0 }); await f.call(encodePayment(txid, nonce)); expect((await f.call(encodePayment(txid2, nonce))).body.error).toBe('nonce_claimed'); await f.cleanup(); });
  it('returns pending with retry-after when unseen', async () => { const f = await fixture(); const nonce = (await f.call()).body.accepts[0].extra.nonce; f.setResult({ found: false, valueZats: 0, memo: '', height: 0, confirmations: 0 }); const r = await f.call(encodePayment(txid, nonce)); expect(r.body.error).toBe('payment_pending'); expect(r.headers['Retry-After']).toBe('20'); await f.cleanup(); });
  it('rejects wrong memo', async () => { const f = await fixture(); const nonce = (await f.call()).body.accepts[0].extra.nonce; f.setResult({ found: true, valueZats: 2000, memo: 'wrong', height: 100, confirmations: 2 }); expect((await f.call(encodePayment(txid, nonce))).body.error).toBe('payment_invalid_memo'); await f.cleanup(); });
  it('rejects insufficient amount', async () => { const f = await fixture(); const nonce = (await f.call()).body.accepts[0].extra.nonce; f.setResult({ found: true, valueZats: 1999, memo: `oboro:${nonce}`, height: 100, confirmations: 2 }); expect((await f.call(encodePayment(txid, nonce))).body.error).toBe('payment_insufficient'); await f.cleanup(); });
  it('rejects malformed payment header', async () => { const f = await fixture(); expect((await f.call('bad')).body.error).toBe('payment_malformed'); await f.cleanup(); });
  it('rejects a nonce on another path', async () => { const f = await fixture(); const nonce = (await f.call()).body.accepts[0].extra.nonce; expect((await f.call(encodePayment(txid2, nonce), '/other')).body.error).toBe('nonce_unknown'); await f.cleanup(); });
  it('returns pending promptly during a slow view-wallet sync', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oboro-slow-'));
    const wall = createPaywall({ payTo: 'utest1seller', stateFile: join(dir, 'state.json'), network: 'zcash-testnet', verificationWaitMs: 1, verifier: { find: () => new Promise(() => {}) } });
    const invoke = async (header?: string) => { let status = 200; let body: any; const req = { path: '/tip', get: (name: string) => name === 'X-PAYMENT' ? header : undefined }; const res = { status: (n: number) => { status = n; return res; }, json: (v: unknown) => { body = v; }, set: (_k: string, _v: string) => {} }; await wall.price(2000, 'tip')(req, res, () => {}); return { status, body }; };
    const nonce = (await invoke()).body.accepts[0].extra.nonce;
    expect(await invoke(encodePayment(txid, nonce))).toMatchObject({ status: 402, body: { error: 'payment_pending' } });
    await rm(dir, { recursive: true, force: true });
  });
});
