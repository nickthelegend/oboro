import { OboroError } from './errors.js';

export type Chain = 'testnet' | 'mainnet';
export type Network = 'zcash-testnet' | 'zcash-mainnet';

export function resolveChain(option?: string): Chain {
  const env = process.env.OBORO_CHAIN;
  if (env !== undefined && env !== 'testnet' && env !== 'mainnet') throw new OboroError('network_refused', 'OBORO_CHAIN must be testnet or mainnet');
  const chain = option ?? env ?? 'testnet';
  if (chain !== 'testnet' && chain !== 'mainnet') throw new OboroError('network_refused', 'Unsupported Zcash chain');
  if (chain === 'mainnet' && env !== 'mainnet') throw new OboroError('network_refused', 'Mainnet requires OBORO_CHAIN=mainnet');
  return chain;
}

export const networkFor = (chain: Chain): Network => chain === 'mainnet' ? 'zcash-mainnet' : 'zcash-testnet';
export const addressPrefix = (network: Network): string => network === 'zcash-mainnet' ? 'u1' : 'utest1';
