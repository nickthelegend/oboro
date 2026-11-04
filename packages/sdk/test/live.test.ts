import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { ZingoSession, ZingoViewVerifier, ZingoWallet } from '../src/index.js';

describe.skipIf(process.env.OBORO_LIVE !== '1')('real Zcash testnet wallet reads', () => {
  it('times a persistent view-only session without sending payment', async () => {
    if (!process.env.OBORO_SELLER_VIEW_DIR) throw new Error('Setup required: OBORO_SELLER_VIEW_DIR');
    const session = new ZingoSession(resolve(process.cwd(), '../../', process.env.OBORO_SELLER_VIEW_DIR));
    try {
      const firstStarted = performance.now();
      const first = JSON.parse(await session.exec('height')) as { height: number };
      const firstMs = Math.round(performance.now() - firstStarted);
      const secondStarted = performance.now();
      const second = JSON.parse(await session.exec('height')) as { height: number };
      const secondMs = Math.round(performance.now() - secondStarted);
      const syncStarted = performance.now();
      const syncedHeight = await session.ensureSynced(20_000);
      const ensureSyncedMs = Math.round(performance.now() - syncStarted);
      expect(first.height).toBeGreaterThan(0);
      expect(second.height).toBeGreaterThan(0);
      expect(syncedHeight).toBeGreaterThan(0);
      console.log(JSON.stringify({ live: 'persistent_view_session', firstMs, secondMs, ensureSyncedMs, syncedHeight }));
    } finally { await session.close(); }
  }, 420_000);
  it('reads the buyer confirmed balance offline', async () => {
    if (!process.env.OBORO_BUYER_WALLET_DIR) throw new Error('Setup required: OBORO_BUYER_WALLET_DIR');
    const balance = await new ZingoWallet({ dataDir: process.env.OBORO_BUYER_WALLET_DIR }).balance();
    expect(balance).toBeGreaterThan(0);
    console.log(JSON.stringify({ live: 'buyer_balance', confirmedZats: balance }));
  }, 60_000);
  it('finds a historical seller receipt in the recently scanned view-only wallet', async () => {
    if (!process.env.OBORO_SELLER_VIEW_DIR) throw new Error('Setup required: OBORO_SELLER_VIEW_DIR');
    const verifier = new ZingoViewVerifier({ dataDir: resolve(process.cwd(), '../../', process.env.OBORO_SELLER_VIEW_DIR) });
    const receipt = await verifier.find('656d03c9760ad158584cc2552cdb1d3d5c349ea0e766bcd5231485760dcdaa66', '0'.repeat(32), 128_000);
    expect(receipt.found).toBe(true);
    expect(receipt.valueZats).toBe(128_000);
    expect(receipt.height).toBe(4548940);
    console.log(JSON.stringify({ live: 'historical_seller_receipt', txid: '656d03c9760ad158584cc2552cdb1d3d5c349ea0e766bcd5231485760dcdaa66', ...receipt }));
  }, 300_000);
});
