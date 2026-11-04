// Oboro console server: the only backend the dashboard talks to.
// It reads live status from the two oboro-node processes and Tsuki, and runs Kumo (the buyer agent)
// through the real SDK when you press a button. Nothing here is simulated: if a piece is down, /api/state says so.
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAgent, ZingoWallet, OboroError, type AgentEvent } from 'oboro';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

// Load the repo's gitignored .env (KEY=VALUE lines) without printing anything.
const envFile = join(repo, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const TUNNEL = process.env.OBORO_TUNNEL_URL ?? 'http://127.0.0.1:7410';
const GATE_STATUS = process.env.OBORO_GATE_STATUS_URL ?? 'http://127.0.0.1:7411';
const SELLER = process.env.OBORO_SELLER_URL ?? 'http://127.0.0.1:7420';
const PORT = Number(process.env.OBORO_CONSOLE_PORT ?? 7430);
const MAX_PER = Number(process.env.OBORO_MAX_PER_REQUEST_ZATS ?? 50_000);
const DAILY = Number(process.env.OBORO_DAILY_CAP_ZATS ?? 300_000);
const SPEND_FILE = resolve(repo, process.env.OBORO_SPEND_FILE ?? '.oboro/agent-spend.json');

const CATALOG = [
  { endpoint: 'tip', path: '/v1/intel/tip', priceZats: 2_000, description: 'Latest Zcash testnet height, read by Tsuki' },
  { endpoint: 'fees', path: '/v1/intel/fees', priceZats: 3_000, description: 'ZIP 317 fee table, computed by Tsuki' },
];

type UiEvent = { ts: string; type: string; detail?: string; txid?: string; zats?: number; mixMs?: number; status?: number };
type Run = {
  id: string;
  endpoint: string;
  path: string;
  priceZats?: number;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'paid' | 'refused' | 'failed';
  txid?: string;
  height?: number;
  mixMs?: number;
  events: UiEvent[];
  response?: string;
  error?: string;
};
const runs: Run[] = [];

async function getJson<T>(url: string, ms = 2500): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The buyer balance needs a zingo-cli call (offline, cached state). Refresh at most once a minute.
let balanceCache: { zats?: number; at?: string; error?: string; pending?: boolean } = {};
function refreshBalance(force = false) {
  const dir = process.env.OBORO_BUYER_WALLET_DIR;
  if (!dir) return;
  if (balanceCache.pending) return;
  if (!force && balanceCache.at && Date.now() - Date.parse(balanceCache.at) < 60_000) return;
  balanceCache.pending = true;
  new ZingoWallet({ dataDir: dir })
    .balance()
    .then((zats) => (balanceCache = { zats, at: new Date().toISOString() }))
    .catch((e) => (balanceCache = { error: errMsg(e), at: new Date().toISOString() }));
}

function spentToday(): number {
  try {
    const s = JSON.parse(readFileSync(SPEND_FILE, 'utf8')) as { day: string; total: number };
    return s.day === new Date().toISOString().slice(0, 10) ? s.total : 0;
  } catch {
    return 0;
  }
}

async function sellerNymAddress(): Promise<string | undefined> {
  if (process.env.OBORO_SELLER_NYM_ADDRESS) return process.env.OBORO_SELLER_NYM_ADDRESS;
  try {
    return (await getJson<{ nymAddress?: string }>(`${GATE_STATUS}/status`)).nymAddress;
  } catch {
    return undefined;
  }
}

type LedgerRow = { ts: string; path: string; priceZats: number; txid?: string; status: string };
// Tsuki's ledger appends a row per attempt (challenge issued, each pending poll, settled).
// Show one row per payment: the latest status for each txid; unpaid challenges are left out.
function collapseLedger(rows: LedgerRow[]): LedgerRow[] {
  const byTx = new Map<string, LedgerRow>();
  for (const r of rows) if (r.txid) byTx.set(r.txid, { ...r, status: r.status === 'settled' ? 'paid' : r.status });
  return [...byTx.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.get('/api/state', async (_req, res) => {
  refreshBalance();
  const [tunnel, gate, gateEvents, ledger] = await Promise.allSettled([
    getJson<Record<string, unknown>>(`${TUNNEL}/status`),
    getJson<Record<string, unknown>>(`${GATE_STATUS}/status`),
    getJson<unknown[]>(`${GATE_STATUS}/events?since=0`),
    getJson<{ ledger: unknown[]; payTo?: string }>(`${SELLER}/oboro/ledger`),
  ]);
  const setup: string[] = [];
  if (!process.env.OBORO_BUYER_WALLET_DIR) setup.push('OBORO_BUYER_WALLET_DIR (Kumo’s wallet)');
  if (tunnel.status === 'rejected') setup.push('oboro-node tunnel on 7410');
  if (gate.status === 'rejected') setup.push('oboro-node gate status on 7411');
  if (ledger.status === 'rejected') setup.push('Tsuki (apps/agents seller) on 7420');

  const node = (r: PromiseSettledResult<Record<string, unknown>>) =>
    r.status === 'fulfilled'
      ? {
          ok: true,
          nymAddress: r.value.nymAddress as string | undefined,
          served: (r.value.served as number | undefined) ?? (r.value.requests as number | undefined),
          errors: r.value.errors as number | undefined,
          startedAt: r.value.startedAt as string | undefined,
        }
      : { ok: false, error: errMsg(r.reason) };

  res.json({
    server: 'ok',
    network: 'zcash-testnet',
    setup,
    tunnel: node(tunnel),
    gate: node(gate),
    buyer: {
      ok: !!process.env.OBORO_BUYER_WALLET_DIR && !balanceCache.error,
      balanceZats: balanceCache.zats,
      balanceAt: balanceCache.at,
      spentTodayZats: spentToday(),
      dailyCapZats: DAILY,
      maxPerRequestZats: MAX_PER,
      error: balanceCache.error,
    },
    seller: {
      ok: ledger.status === 'fulfilled',
      payTo: process.env.OBORO_SELLER_ADDRESS || (ledger.status === 'fulfilled' ? ledger.value.payTo : undefined),
      ledger: ledger.status === 'fulfilled' ? collapseLedger(ledger.value.ledger as LedgerRow[]) : [],
      gateEvents: gateEvents.status === 'fulfilled' ? gateEvents.value : [],
      error: ledger.status === 'rejected' ? errMsg(ledger.reason) : undefined,
    },
    catalog: CATALOG,
    runs: runs.slice(0, 20),
  });
});

app.post('/api/run', async (req, res) => {
  const item = CATALOG.find((c) => c.endpoint === req.body?.endpoint);
  if (!item) return res.status(400).json({ error: 'Unknown endpoint' });
  if (runs.some((r) => r.status === 'running')) return res.status(409).json({ error: 'Kumo is already paying for something' });
  const buyerDir = process.env.OBORO_BUYER_WALLET_DIR;
  if (!buyerDir) return res.status(412).json({ error: 'Setup required: OBORO_BUYER_WALLET_DIR' });
  const tsuki = await sellerNymAddress();
  if (!tsuki) return res.status(412).json({ error: 'Setup required: Tsuki’s gate is not running (no Nym address)' });

  const run: Run = { id: randomUUID(), endpoint: item.endpoint, path: item.path, startedAt: new Date().toISOString(), status: 'running', events: [] };
  runs.unshift(run);
  res.json({ id: run.id });

  const push = (e: UiEvent) => run.events.push(e);
  const onEvent = (e: AgentEvent) => {
    const ts = new Date().toISOString();
    switch (e.type) {
      case 'request':
        return push({ ts, type: 'request', detail: `GET nym://Tsuki${item.path} via Kumo’s tunnel` });
      case 'payment_required':
        run.priceZats = e.amountZats;
        return push({ ts, type: 'payment_required', zats: e.amountZats, detail: `Pay to a shielded address (${e.payTo.slice(0, 10)}…)` });
      case 'policy_ok':
        return push({ ts, type: 'policy_ok', zats: e.amountZats, detail: `≤ ${MAX_PER.toLocaleString('en-US')} per call, daily cap ${DAILY.toLocaleString('en-US')}` });
      case 'policy_refused':
        return push({ ts, type: 'policy_refused', detail: e.reason });
      case 'paying':
        return push({ ts, type: 'paying', zats: e.amountZats, detail: 'zingo-cli quicksend, broadcast over the Nym mixnet' });
      case 'paid':
        run.txid = e.txid;
        return push({ ts, type: 'paid', txid: e.txid, detail: `txid ${e.txid.slice(0, 16)}…` });
      case 'pending':
        if (run.events[run.events.length - 1]?.type === 'pending') return;
        return push({ ts, type: 'pending', detail: 'Tsuki answers 402 payment_pending until the note is mined (~75 s blocks)' });
      case 'settled':
        return push({ ts, type: 'settled', detail: 'Memo, amount and nonce checked with a viewing key' });
      case 'response':
        if (e.mixMs) run.mixMs = e.mixMs;
        return push({ ts, type: 'response', status: e.status, mixMs: e.mixMs });
    }
  };

  try {
    const agent = createAgent({
      tunnelUrl: TUNNEL,
      wallet: new ZingoWallet({ dataDir: buyerDir }),
      policy: { maxPerRequestZats: MAX_PER, dailyCapZats: DAILY, allowRecipients: [tsuki] },
      spendFile: SPEND_FILE,
      onEvent,
    });
    const response = await agent.fetch(`nym://${tsuki}${item.path}`);
    const text = await response.text();
    run.response = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
    const pr = response.headers.get('x-payment-response');
    if (pr) {
      try {
        const decoded = JSON.parse(Buffer.from(pr, 'base64').toString('utf8')) as { txid?: string; height?: number };
        run.height = decoded.height;
        run.txid = decoded.txid ?? run.txid;
      } catch {
        /* header is informational */
      }
    }
    run.status = response.ok && run.txid ? 'paid' : response.ok ? 'paid' : 'failed';
    if (!response.ok) run.error = `Tsuki answered HTTP ${response.status}`;
  } catch (e) {
    run.status = e instanceof OboroError && e.code === 'policy_refused' ? 'refused' : 'failed';
    run.error = errMsg(e);
    push({ ts: new Date().toISOString(), type: e instanceof OboroError && e.code === 'policy_refused' ? 'policy_refused' : 'error', detail: errMsg(e) });
  } finally {
    run.finishedAt = new Date().toISOString();
    refreshBalance(true);
  }
});

// Production: serve the built dashboard from the same origin.
const dist = join(here, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ console: `http://127.0.0.1:${PORT}` })));
