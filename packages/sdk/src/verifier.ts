import { OboroError } from './errors.js';
import { runZingo } from './zingo.js';
import { TXID } from './protocol.js';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ZingoSession } from './session.js';

export interface Verification { found: boolean; valueZats: number; memo: string; height: number; confirmations: number }
interface Transfer { txid: string; kind: string; value: number; memos: string[]; blockheight: number; status: string; pools_received: string[] }
export function parseTransfers(output: string): Transfer[] {
  const parsed = JSON.parse(output) as { value_transfers?: Transfer[] };
  if (!Array.isArray(parsed.value_transfers)) throw new OboroError('zingo_parse', 'Invalid zingo messages output');
  return parsed.value_transfers;
}
export class ZingoViewVerifier {
  private lastSync = 0;
  private syncTask?: Promise<void>;
  private readonly session?: ZingoSession;
  constructor(readonly options: { dataDir: string; chain?: string; minConfirmations?: number }) {
    if (options.chain && options.chain !== 'testnet') throw new OboroError('network_refused', 'Only testnet is supported');
    if (!options.dataDir) throw new OboroError('setup_required', 'Setup required: OBORO_SELLER_VIEW_DIR');
    if (options.minConfirmations !== undefined && (!Number.isSafeInteger(options.minConfirmations) || options.minConfirmations < 1)) throw new OboroError('invalid_confirmations', 'minConfirmations must be a positive integer');
    if (process.env.OBORO_ZINGO_SESSION === '1') this.session = ZingoSession.forWallet(options.dataDir);
  }
  private async sync(): Promise<void> {
    if (Date.now() - this.lastSync < 15_000) return;
    if (!this.syncTask) this.syncTask = runZingo(this.options.dataDir, 'info', [], true).then(() => { this.lastSync = Date.now(); }).finally(() => { this.syncTask = undefined; });
    await this.syncTask;
  }
  async find(txid: string, nonce: string, minZats: number): Promise<Verification> {
    if (!TXID.test(txid)) throw new OboroError('invalid_txid', 'Invalid txid');
    if (this.session) {
      // Don't block the paid request on a full sync: the session's background loop keeps scanning. Read what the wallet
      // has now; confirmations come from the wallet's current height, so an unseen or unmined note stays pending.
      void this.session.ensureSynced(20_000).catch(() => undefined);
      const height = (JSON.parse(await this.session.exec('height', [], 30_000)) as { height: number }).height;
      return this.readTransfer(txid, nonce, height);
    }
    // A prior online scan may have saved a confirmed note before its CLI session timed out.
    // Reuse only a recent wallet snapshot with at least three confirmations.
    const modified = await stat(join(this.options.dataDir, 'zingo-wallet.dat')).then(s => s.mtimeMs, () => 0);
    if (Date.now() - modified < 600_000) {
      const cached = await this.readTransfer(txid, nonce);
      if (cached.found && cached.confirmations >= 3) return cached;
    }
    await this.sync();
    return this.readTransfer(txid, nonce);
  }
  private async readTransfer(txid: string, nonce: string, syncedHeight?: number): Promise<Verification> {
    const [messages, heightText] = await Promise.all([this.session ? this.session.exec('messages') : runZingo(this.options.dataDir, 'messages'), syncedHeight === undefined ? runZingo(this.options.dataDir, 'height') : Promise.resolve(JSON.stringify({ height: syncedHeight }))]);
    const chainHeight = (JSON.parse(heightText) as {height: number}).height;
    const candidates = parseTransfers(messages).filter(t => t.txid.toLowerCase() === txid.toLowerCase() && t.kind === 'received' && t.pools_received?.some(p => p === 'Ironwood' || p === 'Orchard'));
    const expectedMemo = `oboro:${nonce}`;
    const match = candidates.find(t => t.memos?.includes(expectedMemo)) ?? candidates[0];
    if (!match) return { found: false, valueZats: 0, memo: '', height: 0, confirmations: 0 };
    const confirmations = match.status === 'confirmed' && match.blockheight > 0 ? Math.max(0, chainHeight - match.blockheight + 1) : 0;
    return { found: !this.session || confirmations >= (this.options.minConfirmations ?? 1), valueZats: Number(match.value), memo: match.memos?.includes(expectedMemo) ? expectedMemo : (match.memos?.[0] ?? ''), height: match.blockheight, confirmations };
  }
}
