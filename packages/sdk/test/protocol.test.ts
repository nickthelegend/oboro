import { describe, expect, it } from 'vitest';
import { buildChallenge, decodePayment, encodePayment, OboroError, parseChallenge, parseNymUrl, parseTxid, parseConfirmedBalance, parseTransfers, ZingoWallet, ZingoViewVerifier } from '../src/index.js';

const nonce = 'a'.repeat(32);
const txid = 'b'.repeat(64);
describe('nym URL parsing', () => {
  it('parses path and query', () => expect(parseNymUrl('nym://recipient.example/v1/tip?a=1')).toEqual({ address: 'recipient.example', path: '/v1/tip', search: '?a=1' }));
  it('rejects HTTPS', () => expect(() => parseNymUrl('https://example.com')).toThrowError(OboroError));
  it('rejects missing recipient', () => expect(() => parseNymUrl('nym:///tip')).toThrow());
  it('preserves case-sensitive Nym recipient', () => expect(parseNymUrl('nym://AbC123.GhI/v1').address).toBe('AbC123.GhI'));
  it('accepts the Nym recipient gateway separator', () => expect(parseNymUrl('nym://AbC123.GhI@JkL/v1').address).toBe('AbC123.GhI@JkL'));
});
describe('x402 wire format', () => {
  it('builds the stated testnet challenge', () => { const c = buildChallenge('utest1recipient', '/v1/tip', 2000, 'tip', nonce); expect(c.accepts[0]).toMatchObject({ scheme: 'zcash-shielded', network: 'zcash-testnet', maxAmountRequired: '2000', extra: { nonce, memo: `oboro:${nonce}` } }); });
  it('round trips a challenge', () => expect(parseChallenge(buildChallenge('utest1recipient', '/tip', 2000, 'tip', nonce)).error).toBe('payment_required'));
  it('rejects malformed challenge', () => expect(() => parseChallenge({ x402Version: 2 })).toThrow());
  it('rejects a mainnet pay-to address', () => expect(() => buildChallenge('u1mainnet', '/tip', 2000, 'tip', nonce)).toThrow());
  it('round trips X-PAYMENT', () => expect(decodePayment(encodePayment(txid, nonce)).payload).toEqual({ txid, nonce }));
  it('rejects malformed X-PAYMENT', () => expect(() => decodePayment('e30=')).toThrow());
  it('rejects mainnet wallet', () => expect(() => new ZingoWallet({ dataDir: '/tmp/x', chain: 'mainnet' })).toThrow());
  it('rejects mainnet verifier', () => expect(() => new ZingoViewVerifier({ dataDir: '/tmp/x', chain: 'mainnet' })).toThrow());
  it('round trips a mainnet challenge', () => {
    const c = buildChallenge('u1recipient', '/tip', 2000, 'tip', nonce, undefined, undefined, 'zcash-mainnet');
    expect(parseChallenge(c, 'zcash-mainnet').accepts[0].network).toBe('zcash-mainnet');
  });
  it('rejects a challenge with a mismatched address prefix', () => {
    const c = buildChallenge('utest1recipient', '/tip', 2000, 'tip', nonce);
    c.accepts[0].network = 'zcash-mainnet';
    expect(() => parseChallenge(c)).toThrowError(expect.objectContaining({ code: 'network_mismatch' }));
  });
});
describe('captured offline zingo output shapes', () => {
  const capturedTransfer = `{"value_transfers":[{"txid":"656d03c9760ad158584cc2552cdb1d3d5c349ea0e766bcd5231485760dcdaa66","datetime":1793141430,"status":"confirmed","blockheight":4548940,"kind":"received","value":128000,"recipient_address":null,"pools_sent_from":[],"pools_received":["Ironwood"],"memos":["sba1:41326350051297043999027461969186965087:seller"]}]}`;
  it('parses real messages value_transfers shape', () => expect(parseTransfers(capturedTransfer)[0]).toMatchObject({ kind: 'received', value: 128000, blockheight: 4548940 }));
  it('finds txid in captured transfer text', () => expect(parseTxid('txid: 656d03c9760ad158584cc2552cdb1d3d5c349ea0e766bcd5231485760dcdaa66')).toBe('656d03c9760ad158584cc2552cdb1d3d5c349ea0e766bcd5231485760dcdaa66'));
  it('finds txid in JSON-shaped output', () => expect(parseTxid(`{"txid":"${txid}"}`)).toBe(txid));
  it('throws when quicksend output has no txid', () => expect(() => parseTxid('send failed')).toThrow());
  it('parses confirmed Ironwood and Orchard balance', () => expect(parseConfirmedBalance('[\n confirmed_ironwood_balance: 982_000\n confirmed_orchard_balance: 2_000\n]')).toBe(984000));
});
