import './env.js';
import { createWallet, OboroError, required, ZingoWallet } from 'oboro';
import { repoPath } from './env.js';

const address = process.argv.slice(2).find(a => !a.startsWith('--')) ?? required('OBORO_SELLER_NYM_ADDRESS');
const agent = createWallet({
  tunnelUrl: process.env.OBORO_TUNNEL_URL ?? 'http://127.0.0.1:7410',
  wallet: new ZingoWallet({ dataDir: required('OBORO_BUYER_WALLET_DIR') }),
  policy: { maxPerRequestZats: Number(process.env.OBORO_MAX_PER_REQUEST_ZATS ?? 50_000), dailyCapZats: Number(process.env.OBORO_DAILY_CAP_ZATS ?? 300_000), allowRecipients: [address] },
  spendFile: repoPath(process.env.OBORO_SPEND_FILE ?? '.oboro/agent-spend.json'),
  onEvent: event => console.log(JSON.stringify({ agent: 'agent wallet', ...event }))
});
try {
  const tipResponse = await agent.fetch(`nym://${address}/v1/intel/tip`);
  if (!tipResponse.ok) throw new Error(`Tip request failed: ${tipResponse.status}`);
  const tip = await tipResponse.json() as { height: number };
  console.log(JSON.stringify({ agent: 'agent wallet', decision: 'tip_received', height: tip.height }));
  // Buy the fixed, low-price fee table when the tip is a real positive height and budget permits.
  if (Number.isSafeInteger(tip.height) && tip.height > 0 && await agent.spentToday() + 3_000 <= agent.policy.dailyCapZats) {
    console.log(JSON.stringify({ agent: 'agent wallet', decision: 'buy_fees', reason: 'valid chain tip and 3000 zats within daily budget' }));
    const feesResponse = await agent.fetch(`nym://${address}/v1/intel/fees`);
    if (!feesResponse.ok) throw new Error(`Fees request failed: ${feesResponse.status}`);
    console.log(JSON.stringify({ agent: 'agent wallet', decision: 'fees_received', data: await feesResponse.json() }));
  } else console.log(JSON.stringify({ agent: 'agent wallet', decision: 'skip_fees', reason: 'invalid tip or budget exhausted' }));
} catch (error) {
  console.error(JSON.stringify({ agent: 'agent wallet', error: error instanceof OboroError ? error.code : 'unexpected', message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
