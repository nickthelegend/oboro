import '../src/env.js';
import { ShopLedger, ShopError } from '@oboro/shop';
import { repoPath } from '../src/env.js';

const id = process.argv[2];
if (!id) { console.error('Usage: pnpm --filter @oboro/agents shop:approve <approval_id>'); process.exitCode = 2; }
else {
  try {
    const ledger = new ShopLedger(repoPath(process.env.OBORO_SHOP_LEDGER ?? '.oboro/shop.json'));
    const record = await ledger.approve(id);
    console.log(JSON.stringify({ status: 'approved', approval_id: id, product_id: record.product_id, value: record.value, usd: record.usd }));
  } catch (error) {
    const e = error as ShopError; console.error(JSON.stringify({ code: e.code ?? 'approval_failed', error: e.message })); process.exitCode = 1;
  }
}
