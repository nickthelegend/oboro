// Example: an agent that pays per API call using the Oboro SDK.
import './env.js';
import { createWallet, OboroError, required, ZingoWallet } from 'oboro';
import { repoPath } from './env.js';

const address = process.argv.slice(2).find(a => !a.startsWith('--')) ?? required('OBORO_SELLER_NYM_ADDRESS');
const wallet = createWallet({
  tunnelUrl: process.env.OBORO_TUNNEL_URL ?? 'http://127.0.0.1:7410',
  wallet: new ZingoWallet({ dataDir: required('OBORO_BUYER_WALLET_DIR') }),
  policy: { maxPerRequestZats: Number(process.env.OBORO_MAX_PER_REQUEST_ZATS ?? 50_000), dailyCapZats: Number(process.env.OBORO_DAILY_CAP_ZATS ?? 300_000), allowRecipients: [address] },
  spendFile: repoPath(process.env.OBORO_SPEND_FILE ?? '.oboro/agent-spend.json'),
  onEvent: event => console.log(JSON.stringify({ example: 'paid-api-agent', ...event }))
});
try {
  const tipResponse = await wallet.fetch(`nym://${address}/v1/intel/tip`);
  if (!tipResponse.ok) throw new Error(`Tip request failed: ${tipResponse.status}`);
  const tip = await tipResponse.json() as { height: number };
  console.log(JSON.stringify({ example: 'paid-api-agent', decision: 'tip_received', height: tip.height }));
  // Buy the fixed, low-price fee table when the tip is a real positive height and budget permits.
  if (Number.isSafeInteger(tip.height) && tip.height > 0 && await wallet.spentToday() + 3_000 <= wallet.policy.dailyCapZats) {
    console.log(JSON.stringify({ example: 'paid-api-agent', decision: 'buy_fees', reason: 'valid chain tip and 3000 zats within daily budget' }));
    const feesResponse = await wallet.fetch(`nym://${address}/v1/intel/fees`);
    if (!feesResponse.ok) throw new Error(`Fees request failed: ${feesResponse.status}`);
    console.log(JSON.stringify({ example: 'paid-api-agent', decision: 'fees_received', data: await feesResponse.json() }));
  } else console.log(JSON.stringify({ example: 'paid-api-agent', decision: 'skip_fees', reason: 'invalid tip or budget exhausted' }));
} catch (error) {
  console.error(JSON.stringify({ example: 'paid-api-agent', error: error instanceof OboroError ? error.code : 'unexpected', message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
