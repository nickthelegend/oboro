import { randomBytes } from 'node:crypto';
import { OboroError } from './errors.js';
import { addressPrefix, type Network } from './chain.js';

export interface Accept {
  scheme: 'zcash-shielded'; network: Network; maxAmountRequired: string;
  asset: 'ZEC'; payTo: string; resource: string; description: string;
  mimeType: 'application/json'; maxTimeoutSeconds: number;
  extra: { nonce: string; memo: string; expiresAt: string; minConfirmations: number };
}
export interface Challenge { x402Version: 1; error: string; accepts: Accept[] }
export interface Payment { x402Version: 1; scheme: 'zcash-shielded'; network: Network; payload: { txid: string; nonce: string } }
export const TXID = /^[a-f0-9]{64}$/i;
export const NONCE = /^[a-f0-9]{32}$/i;

export function buildChallenge(payTo: string, resource: string, priceZats: number, description: string, nonce = randomBytes(16).toString('hex'), expiresAt = new Date(Date.now() + 900_000).toISOString(), error = 'payment_required', network: Network = 'zcash-testnet'): Challenge {
  if (!Number.isSafeInteger(priceZats) || priceZats <= 0) throw new OboroError('invalid_price', 'Price must be a positive integer in zatoshis');
  if (network !== 'zcash-testnet' && network !== 'zcash-mainnet') throw new OboroError('network_refused', 'Unsupported Zcash network');
  if (!payTo.startsWith(addressPrefix(network))) throw new OboroError('network_mismatch', 'Pay-to address does not match challenge network');
  if (!NONCE.test(nonce)) throw new OboroError('invalid_nonce', 'Nonce must be 128-bit hex');
  return { x402Version: 1, error, accepts: [{ scheme: 'zcash-shielded', network, maxAmountRequired: String(priceZats), asset: 'ZEC', payTo, resource, description, mimeType: 'application/json', maxTimeoutSeconds: 900, extra: { nonce, memo: `oboro:${nonce}`, expiresAt, minConfirmations: 1 } }] };
}
export function parseChallenge(value: unknown, network?: Network): Challenge {
  const v = value as Partial<Challenge>;
  const a = v?.accepts?.[0];
  if (v?.x402Version !== 1 || !a || a.scheme !== 'zcash-shielded' || (a.network !== 'zcash-testnet' && a.network !== 'zcash-mainnet') || !NONCE.test(a.extra?.nonce ?? '') || a.extra.memo !== `oboro:${a.extra.nonce}` || !/^\d+$/.test(a.maxAmountRequired) || !Number.isSafeInteger(Number(a.maxAmountRequired)) || Number(a.maxAmountRequired) <= 0 || !Number.isFinite(Date.parse(a.extra.expiresAt)) || !Number.isSafeInteger(a.extra.minConfirmations) || a.extra.minConfirmations < 1) throw new OboroError('invalid_challenge', 'Invalid Zcash x402 challenge');
  if (network && a.network !== network) throw new OboroError('network_mismatch', 'Challenge network does not match expected network');
  if (!a.payTo?.startsWith(addressPrefix(a.network))) throw new OboroError('network_mismatch', 'Pay-to address does not match challenge network');
  return v as Challenge;
}
export function encodePayment(txid: string, nonce: string, network: Network = 'zcash-testnet'): string {
  if (!TXID.test(txid) || !NONCE.test(nonce)) throw new OboroError('invalid_payment', 'Invalid txid or nonce');
  if (network !== 'zcash-testnet' && network !== 'zcash-mainnet') throw new OboroError('network_refused', 'Unsupported Zcash network');
  return Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'zcash-shielded', network, payload: { txid, nonce } } satisfies Payment)).toString('base64');
}
export function decodePayment(header: string): Payment {
  let v: Payment;
  try { v = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as Payment; } catch { throw new OboroError('payment_malformed', 'Malformed X-PAYMENT'); }
  if (v?.x402Version !== 1 || v.scheme !== 'zcash-shielded' || (v.network !== 'zcash-testnet' && v.network !== 'zcash-mainnet') || !TXID.test(v.payload?.txid ?? '') || !NONCE.test(v.payload?.nonce ?? '')) throw new OboroError('payment_malformed', 'Malformed X-PAYMENT');
  return v;
}
