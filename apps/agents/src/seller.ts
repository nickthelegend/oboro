import './env.js';
import express from 'express';
import { createPaywall, required, runZingo, ZingoViewVerifier, ZingoWallet } from 'oboro';
import { repoPath } from './env.js';

const wallet = new ZingoWallet({ dataDir: required('OBORO_SELLER_WALLET_DIR') });
const payTo = process.env.OBORO_SELLER_ADDRESS || await wallet.unifiedAddress();
const viewDir = repoPath(required('OBORO_SELLER_VIEW_DIR'));
const paywall = createPaywall({ payTo, verifier: new ZingoViewVerifier({ dataDir: viewDir }), stateFile: repoPath(process.env.OBORO_PAYWALL_STATE ?? '.oboro/paywall.json'), network: 'zcash-testnet' });
const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true, agent: 'Tsuki' }));
app.get('/v1/intel/tip', paywall.price(2_000, 'Latest Zcash testnet height'), async (_req, res, next) => {
  try {
    const raw = await runZingo(viewDir, 'height');
    const { height } = JSON.parse(raw) as { height: number };
    res.json({ agent: 'Tsuki', network: 'zcash-testnet', height, observedAt: new Date().toISOString(), source: 'seller view-only zingo wallet height after payment verification' });
  } catch (error) { next(error); }
});
app.get('/v1/intel/fees', paywall.price(3_000, 'ZIP 317 computed fee table'), (_req, res) => {
  res.json({ agent: 'Tsuki', source: 'ZIP 317 formula', computed: true, marginalFeeZats: 5_000, graceActions: 2, fees: [1, 2, 3, 4].map(actions => ({ actions, feeZats: Math.max(2, actions) * 5_000 })) });
});
app.get('/oboro/ledger', async (_req, res, next) => {
  try {
    const ledger = await paywall.ledger();
    res.json({ agent: 'Tsuki', ledger, sellerSaw: { mixnetPeer: '127.0.0.1', payerAddress: null, explanation: 'The gate forwards a local HTTP request; shielded payments do not reveal a payer address to this service.' } });
  } catch (error) { next(error); }
});
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { console.error(error.message); res.status(500).json({ error: 'internal_error' }); });
const server = app.listen(7420, '127.0.0.1', () => console.log(JSON.stringify({ agent: 'Tsuki', listening: '127.0.0.1:7420' })));
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
