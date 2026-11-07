import './env.js';
import { createInterface } from 'node:readline/promises';
import { createWallet, required, ZingoWallet } from 'oboro';
import { createShoppingAgent } from './agent.js';

const address = required('OBORO_SELLER_NYM_ADDRESS');
const wallet = createWallet({
  tunnelUrl: process.env.OBORO_TUNNEL_URL ?? 'http://127.0.0.1:7410',
  wallet: new ZingoWallet({ dataDir: required('OBORO_BUYER_WALLET_DIR') }),
  policy: {
    maxPerRequestZats: Number(process.env.OBORO_MAX_PER_REQUEST_ZATS ?? 50_000),
    dailyCapZats: Number(process.env.OBORO_DAILY_CAP_ZATS ?? 300_000),
    allowRecipients: [address],
  },
});
const agent = createShoppingAgent({ shop: wallet.merchant(address), budget: wallet.budget });
const input = createInterface({ input: process.stdin, output: process.stdout });
let sessionId = '';
try {
  for (;;) {
    const message = (await input.question('You: ')).trim();
    if (!message || message === '/quit') break;
    const result = await agent.chat(sessionId, message);
    sessionId = result.sessionId;
    const turn = result.turns.at(-1);
    console.log(`Agent: ${turn?.text ?? ''}`);
    for (const trace of turn?.tools ?? []) console.log(`  ${trace.name}: ${trace.summary}`);
  }
} finally {
  input.close();
}
