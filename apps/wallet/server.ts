// Oboro wallet server: the backend the wallet app talks to.
// It reads live status from the two oboro-node processes and gateway, and runs the example agent
// through the real SDK when you press a button. Nothing here is simulated: if a piece is down, /api/state says so.
import express from 'express';
import { chmodSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createWallet, ZingoWallet, OboroError, type AgentEvent } from 'oboro';
import { createShoppingAgent, type RelayHandle } from '@oboro/example-shopping-agent';

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
const CHAIN = process.env.OBORO_CHAIN ?? 'testnet';
if (CHAIN !== 'testnet' && CHAIN !== 'mainnet') throw new Error('OBORO_CHAIN must be testnet or mainnet');
const NETWORK = CHAIN === 'mainnet' ? 'zcash-mainnet' : 'zcash-testnet';
// mainnet.zcashexplorer.app did not index our v6 mainnet transactions (4 Nov 2026); Blockchair does.
const EXPLORER = CHAIN === 'mainnet' ? 'https://blockchair.com/zcash/transaction/' : 'https://testnet.zcashexplorer.app/transactions/';

const CATALOG = [
  { endpoint: 'tip', path: '/v1/intel/tip', priceZats: 2_000, description: 'Latest Zcash testnet height, read by gateway' },
  { endpoint: 'fees', path: '/v1/intel/fees', priceZats: 3_000, description: 'ZIP 317 fee table, computed by gateway' },
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
  new ZingoWallet({ dataDir: dir, chain: CHAIN })
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
// gateway's ledger appends a row per attempt (challenge issued, each pending poll, settled).
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
  if (!process.env.OBORO_BUYER_WALLET_DIR) setup.push('OBORO_BUYER_WALLET_DIR (agent wallet)');
  if (tunnel.status === 'rejected') setup.push('oboro-node tunnel on 7410');
  if (gate.status === 'rejected') setup.push('oboro-node gate status on 7411');
  if (ledger.status === 'rejected') setup.push('gateway (apps/gateway) on 7420');

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
    network: NETWORK,
    explorerBase: EXPLORER,
    setup,
    tunnel: node(tunnel),
    gate: node(gate),
    wallet: {
      ok: !!process.env.OBORO_BUYER_WALLET_DIR && !balanceCache.error,
      balanceZats: balanceCache.zats,
      balanceAt: balanceCache.at,
      spentTodayZats: spentToday(),
      dailyCapZats: DAILY,
      maxPerRequestZats: MAX_PER,
      error: balanceCache.error,
    },
    gateway: {
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
  if (runs.some((r) => r.status === 'running')) return res.status(409).json({ error: 'agent wallet is already paying for something' });
  const buyerDir = process.env.OBORO_BUYER_WALLET_DIR;
  if (!buyerDir) return res.status(412).json({ error: 'Setup required: OBORO_BUYER_WALLET_DIR' });
  const gateway = await sellerNymAddress();
  if (!gateway) return res.status(412).json({ error: 'Setup required: the merchant gateway’s Nym gate is not running (no Nym address)' });

  const run: Run = { id: randomUUID(), endpoint: item.endpoint, path: item.path, startedAt: new Date().toISOString(), status: 'running', events: [] };
  runs.unshift(run);
  res.json({ id: run.id });

  const push = (e: UiEvent) => run.events.push(e);
  const onEvent = (e: AgentEvent) => {
    const ts = new Date().toISOString();
    switch (e.type) {
      case 'request':
        return push({ ts, type: 'request', detail: `GET nym://gateway${item.path} via agent wallet’s tunnel` });
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
        return push({ ts, type: 'pending', detail: 'gateway answers 402 payment_pending until its viewing key sees the mined note (NU7 testnet blocks ≈ 25 s)' });
      case 'settled':
        return push({ ts, type: 'settled', detail: 'Memo, amount and nonce checked with a viewing key' });
      case 'response':
        if (e.mixMs) run.mixMs = e.mixMs;
        return push({ ts, type: 'response', status: e.status, mixMs: e.mixMs });
    }
  };

  try {
    const agent = createWallet({
      tunnelUrl: TUNNEL,
      wallet: new ZingoWallet({ dataDir: buyerDir, chain: CHAIN }),
      policy: { maxPerRequestZats: MAX_PER, dailyCapZats: DAILY, allowRecipients: [gateway] },
      spendFile: SPEND_FILE,
      onEvent,
    });
    const response = await agent.fetch(`nym://${gateway}${item.path}`);
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
    if (!response.ok) run.error = `gateway answered HTTP ${response.status}`;
  } catch (e) {
    run.status = e instanceof OboroError && e.code === 'policy_refused' ? 'refused' : 'failed';
    run.error = errMsg(e);
    push({ ts: new Date().toISOString(), type: e instanceof OboroError && e.code === 'policy_refused' ? 'policy_refused' : 'error', detail: errMsg(e) });
  } finally {
    run.finishedAt = new Date().toISOString();
    refreshBalance(true);
  }
});

// ───────────────────────── Shop: agent wallet buys a real thing through gateway's Bitrefill shop ─────────────────────────
// Every step crosses the Nym mixnet: browse (free), quote (free), then a paid POST whose shielded payment
// authorises one Bitrefill purchase that gateway pays from its event credits. Codes never reach this UI unmasked.
type ShopStep = { ts: string; type: string; detail?: string; txid?: string; zats?: number; usd?: number; mixMs?: number; status?: number };
type ShopRun = {
  id: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'delivered' | 'processing' | 'needs_approval' | 'refused' | 'failed';
  product?: { id: string; name: string; value: string; currency: string; usd: number };
  by?: 'button' | 'agent'; phoneMasked?: string; txid?: string; invoiceId?: string; orderId?: string; receiptId?: string;
  redemptionMasked?: Record<string, string>; steps: ShopStep[]; error?: string;
};
const shopRuns: ShopRun[] = [];
// Approval ids stay server-side (operator only); the agent never gets a tool that approves.
const approvals = new Map<string, string>();
const maskValue = (v: string) => (v.length <= 8 ? '•'.repeat(v.length) : `${v.slice(0, 2)}${'•'.repeat(Math.min(10, v.length - 4))}${v.slice(-2)}`);
const maskRedemption = (r: unknown): Record<string, string> | undefined => {
  if (!r || typeof r !== 'object') return undefined;
  return Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [k, k === 'instructions' ? 'present' : maskValue(String(v))]));
};
const maskPhone = (p?: string) => (p ? `${p.slice(0, 3)} ••••• ${p.slice(-4)}` : undefined);

async function viaNym(gateway: string, path: string, init: RequestInit = {}) {
  const started = Date.now();
  const res = await fetch(`${TUNNEL}/nym/${encodeURIComponent(gateway)}${path}`, { ...init, signal: AbortSignal.timeout(130_000) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body as Record<string, unknown>, mixMs: Number(res.headers.get('x-oboro-mix-ms')) || Date.now() - started };
}

app.get('/api/shop', async (_req, res) => {
  const shop = await getJson<Record<string, unknown>>(`${SELLER}/oboro/shop`).catch((e) => ({ error: errMsg(e) }));
  const setup: string[] = [];
  // A phone is only needed for top-ups (airtel-india); gift cards need no personal data.
  res.json({ network: NETWORK, explorerBase: EXPLORER, gateway: shop, consoleSetup: setup, phoneMasked: maskPhone(process.env.OBORO_SHOP_PHONE), runs: shopRuns.slice(0, 10) });
});

// Free catalog read through the mixnet, cached for a minute: the Shop page's live quote before any errand.
let quoteCache: { at: number; body?: unknown; mixMs?: number; error?: string } = { at: 0 };
app.get('/api/shop/quote', async (_req, res) => {
  if (Date.now() - quoteCache.at < 60_000 && (quoteCache.body || quoteCache.error)) return res.json({ ...quoteCache, cached: true });
  const gateway = await sellerNymAddress();
  if (!gateway) return res.status(412).json({ error: 'Setup required: the merchant gateway’s Nym gate is not running (no Nym address)' });
  try {
    const q = await viaNym(gateway, '/v1/shop/product/swiggy-money-india');
    quoteCache = q.status === 200 ? { at: Date.now(), body: q.body, mixMs: q.mixMs } : { at: Date.now(), error: String(q.body.error ?? `HTTP ${q.status}`) };
  } catch (e) {
    quoteCache = { at: Date.now(), error: errMsg(e) };
  }
  res.json({ ...quoteCache, cached: false });
});

// Starts one shop errand (button or agent). Returns the run, or an error the caller shows as-is.
export async function launchShopRun(productIdIn: unknown, valueIn: unknown, by: 'button' | 'agent' = 'button'): Promise<{ run?: ShopRun; status: number; error?: string }> {
  const productId = String(productIdIn ?? 'swiggy-money-india');
  const value = String(valueIn ?? '50');
  if (!/^[a-z0-9-]{1,100}$/.test(productId) || !/^(?:\d+(?:\.\d+)?|[\w .+/–-]{1,80})$/.test(value)) return { status: 400, error: 'product_id and a package value are required' };
  if (runs.some((r) => r.status === 'running') || shopRuns.some((r) => r.status === 'running')) return { status: 409, error: 'agent wallet is already paying for something' };
  const buyerDir = process.env.OBORO_BUYER_WALLET_DIR;
  if (!buyerDir) return { status: 412, error: 'Setup required: OBORO_BUYER_WALLET_DIR' };
  const topUp = productId === 'airtel-india' || /-bundles(-india)?$|-india-bundles$/.test(productId);
  const phone = topUp ? process.env.OBORO_SHOP_PHONE : undefined;
  if (topUp && !phone) return { status: 412, error: 'Setup required: a phone number for the top-up (Setup card)' };
  const gateway = await sellerNymAddress();
  if (!gateway) return { status: 412, error: 'Setup required: the merchant gateway’s Nym gate is not running (no Nym address)' };

  const run: ShopRun = { id: randomUUID(), startedAt: new Date().toISOString(), status: 'running', by, phoneMasked: maskPhone(phone), steps: [] };
  shopRuns.unshift(run);
  void runShop(run, gateway, buyerDir, productId, value, phone);
  return { run, status: 200 };
}

async function runShop(run: ShopRun, gateway: string, buyerDir: string, productId: string, value: string, phone: string | undefined) {
  const push = (s: Omit<ShopStep, 'ts'>) => run.steps.push({ ts: new Date().toISOString(), ...s });

  try {
    // 1. Browse gateway's catalog (free). gateway reads it from Bitrefill.
    push({ type: 'browse', detail: `GET nym://gateway/v1/shop/search?q=${productId.split('-')[0]}` });
    const search = await viaNym(gateway, `/v1/shop/search?q=${encodeURIComponent(productId.split('-')[0])}`);
    if (search.status !== 200) throw new Error(`Catalog search failed: ${String(search.body.error ?? search.status)}`);
    const found = (search.body.products as { id: string; name: string; in_stock: boolean }[] | undefined) ?? [];
    push({ type: 'browsed', mixMs: search.mixMs, detail: `${found.length} Bitrefill products; ${found.some((p) => p.id === productId) ? `${productId} in the list` : `${productId} not in the first page`}` });

    // 2. Quote: the package's USD price comes from Bitrefill, never from the request.
    const quote = await viaNym(gateway, `/v1/shop/product/${productId}`);
    if (quote.status !== 200) throw new Error(`Product lookup failed: ${String(quote.body.error ?? quote.status)}`);
    const pkgs = (quote.body.packages as { value: string; usd: number; currency: string }[] | undefined) ?? [];
    const pkg = pkgs.find((p) => String(p.value) === value);
    if (!pkg) throw new Error(`${productId} has no ${value} package`);
    if (quote.body.in_stock === false) throw new Error(`${productId} is out of stock`);
    run.product = { id: productId, name: String(quote.body.name ?? productId), value, currency: pkg.currency || String(quote.body.currency ?? ''), usd: pkg.usd };
    push({ type: 'quoted', usd: pkg.usd, mixMs: quote.mixMs, detail: `${run.product.name}: ${value} ${run.product.currency} = $${pkg.usd.toFixed(2)} (Bitrefill price)` });

    // 3. Pay gateway in shielded ZEC over Nym; the paid POST is the purchase authorisation.
    const agent = createWallet({
      tunnelUrl: TUNNEL,
      wallet: new ZingoWallet({ dataDir: buyerDir, chain: CHAIN }),
      policy: { maxPerRequestZats: MAX_PER, dailyCapZats: DAILY, allowRecipients: [gateway] },
      spendFile: SPEND_FILE,
      onEvent: (e: AgentEvent) => {
        switch (e.type) {
          case 'payment_required': return push({ type: 'payment_required', zats: e.amountZats, detail: 'gateway asks for a shielded payment to authorise the purchase' });
          case 'policy_ok': return push({ type: 'policy_ok', zats: e.amountZats, detail: `agent wallet’s policy: ≤ ${MAX_PER.toLocaleString('en-US')} zats per call, ${DAILY.toLocaleString('en-US')} per day, gateway only` });
          case 'policy_refused': return push({ type: 'policy_refused', detail: e.reason });
          case 'paying': return push({ type: 'paying', zats: e.amountZats, detail: 'zingo-cli quicksend, broadcast over the Nym mixnet' });
          case 'paid': run.txid = e.txid; return push({ type: 'paid', txid: e.txid, detail: `txid ${e.txid.slice(0, 16)}…` });
          case 'pending': if (run.steps[run.steps.length - 1]?.type === 'pending') return; return push({ type: 'pending', detail: 'Waiting for gateway’s viewing key to see the mined note (NU7 blocks ≈ 25 s)' });
          case 'settled': return push({ type: 'settled', detail: 'gateway verified amount, memo and nonce; txid reserved before any Bitrefill call' });
          default: return;
        }
      },
    });
    push({ type: 'request', detail: `POST nym://gateway/v1/shop/buy {${productId}, ${value}${phone ? ', phone' : ''}}` });
    const buy = await agent.fetch(`nym://${gateway}/v1/shop/buy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: productId, value, ...(phone ? { phone_number: phone } : {}) }) });
    let body = (await buy.json().catch(() => ({}))) as Record<string, unknown>;
    let status = buy.status;
    push({ type: 'bitrefill', status, detail: status === 200 ? 'Bitrefill invoice paid from gateway’s balance; order delivered' : `gateway answered ${status} ${String(body.status ?? body.code ?? '')}` });

    // 4. Long fulfilment or a parked over-cap purchase: poll the receipt (free, bearer receipt id) over Nym.
    //    needs_approval waits (up to 30 min) for a human on gateway's side; nothing is bought until then.
    const deadline = Date.now() + 30 * 60_000;
    while (status === 202 && (body.status === 'processing' || body.status === 'needs_approval') && (body.receipt_id || run.receiptId) && Date.now() < deadline) {
      run.receiptId = String(body.receipt_id ?? run.receiptId);
      if (body.status === 'needs_approval') {
        if (body.approval_id) approvals.set(run.id, String(body.approval_id));
        if (run.status !== 'needs_approval') { run.status = 'needs_approval'; push({ type: 'needs_approval', detail: 'Above gateway’s caps: parked, nothing bought. Waiting for a human on gateway’s side to approve.' }); }
      } else {
        if (run.status === 'needs_approval') { run.status = 'running'; push({ type: 'approved', detail: 'Approved by gateway’s operator; Bitrefill order placed' }); }
        if (run.steps[run.steps.length - 1]?.type !== 'processing') push({ type: 'processing', detail: 'Bitrefill order processing; polling the receipt over Nym' });
      }
      await new Promise((r) => setTimeout(r, 5000));
      const r = await viaNym(gateway, `/v1/shop/receipt/${run.receiptId}`);
      status = r.status; body = r.body;
      if (status === 200 && run.status === 'needs_approval') { run.status = 'running'; push({ type: 'approved', detail: 'Approved by gateway’s operator; Bitrefill order placed' }); }
    }
    if (status === 200 && body.status === 'delivered') {
      run.status = 'delivered';
      run.invoiceId = String(body.invoice_id ?? '');
      run.orderId = String(body.order_id ?? '');
      run.redemptionMasked = maskRedemption(body.redemption);
      push({ type: 'delivered', usd: Number(body.usd) || run.product.usd, detail: `Invoice ${run.invoiceId} · order ${run.orderId} delivered` });
    } else if (status === 202 && body.status === 'needs_approval') {
      run.status = 'needs_approval';
      push({ type: 'needs_approval', detail: 'Above the caps: nothing bought. A human approves out of band with pnpm --filter @oboro/gateway shop:approve <id>' });
    } else if (status === 202) {
      run.status = 'processing';
    } else {
      run.status = 'failed';
      run.error = String(body.error ?? body.code ?? `HTTP ${status}`);
      push({ type: 'error', detail: run.error });
    }
  } catch (e) {
    run.status = e instanceof OboroError && e.code === 'policy_refused' ? 'refused' : 'failed';
    run.error = errMsg(e);
    push({ type: run.status === 'refused' ? 'policy_refused' : 'error', detail: run.error });
  } finally {
    run.finishedAt = new Date().toISOString();
    refreshBalance(true);
  }
}

app.post('/api/shop/run', async (req, res) => {
  const r = await launchShopRun(req.body?.product_id, req.body?.value);
  if (!r.run) return res.status(r.status).json({ error: r.error });
  res.json({ id: r.run.id });
});


type RelayRun = { stage: 'quote' | 'paying' | 'paid' | 'verifying' | 'buying' | 'delivered' | 'failed'; quote?: unknown; txid?: string; events: { at: string; type: string; text: string }[]; result?: { receipt_id: string; invoice_id?: string; order_id?: string; code_masked?: Record<string, string> }; error?: string; code?: Record<string, string> };
const relayRuns = new Map<string, RelayRun>();
const localOnly = (ip?: string) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip ?? '');
function buyerCards(gateway: string, onEvent?: (e: AgentEvent) => void) {
  const dir = process.env.OBORO_BUYER_WALLET_DIR;
  if (!dir) throw new Error('Setup required: OBORO_BUYER_WALLET_DIR');
  return createWallet({ tunnelUrl: TUNNEL, wallet: new ZingoWallet({ dataDir: dir, chain: CHAIN }),
    policy: { maxPerRequestZats: MAX_PER, dailyCapZats: DAILY, allowRecipients: [gateway] },
    spendFile: SPEND_FILE, onEvent }).cards(gateway);
}
app.get('/api/relay', async (_req, res) => {
  try {
    const gateway = await sellerNymAddress();
    if (!gateway) return res.status(503).json({ setup: ['OBORO_SELLER_NYM_ADDRESS'], error: 'Relay Nym address unavailable' });
    const [catalog, relay] = await Promise.all([viaNym(gateway, '/v1/cards/catalog'), viaNym(gateway, '/oboro/relay')]);
    if (catalog.status !== 200 || relay.status !== 200) return res.status(503).json({ setup: catalog.body.setup ?? [], error: catalog.body.error ?? relay.body.error ?? 'Relay unavailable' });
    res.json({ ...catalog.body, relay: relay.body });
  } catch (e) { res.status(503).json({ setup: [], error: errMsg(e) }); }
});
app.post('/api/relay/buy', async (req, res) => {
  if (!localOnly(req.socket.remoteAddress)) return res.status(403).json({ error: 'Local only' });
  const product = req.body?.product_id, value = req.body?.value;
  if (typeof product !== 'string' || !/^[a-z0-9-]{1,100}$/.test(product) || !(typeof value === 'string' || typeof value === 'number')) return res.status(400).json({ error: 'Invalid product or value' });
  const gateway = await sellerNymAddress();
  if (!gateway) return res.status(503).json({ error: 'Setup required: OBORO_SELLER_NYM_ADDRESS' });
  const id = randomUUID(); const run: RelayRun = { stage: 'quote', events: [] }; relayRuns.set(id, run);
  const emit = (type: string, text: string) => { run.events.push({ at: new Date().toISOString(), type, text }); };
  const cards = buyerCards(gateway, e => {
    if (e.type === 'payment_required') { run.stage = 'paying'; emit(e.type, `Payment required: ${e.amountZats} zats`); }
    if (e.type === 'paying') { run.stage = 'paying'; emit(e.type, 'Sending shielded payment'); }
    if (e.type === 'paid') { run.stage = 'paid'; run.txid = e.txid; emit(e.type, 'Payment broadcast'); }
    if (e.type === 'pending') { run.stage = 'verifying'; emit(e.type, 'Waiting for confirmation'); }
    if (e.type === 'settled') { run.stage = 'buying'; emit(e.type, 'Payment verified; buying card'); }
  });
  void (async () => {
    try {
      const q = await cards.quote(product, value); run.quote = q; emit('quote', `₹${q.value} costs ${q.zats} zats`);
      const buyer = new ZingoWallet({ dataDir: process.env.OBORO_BUYER_WALLET_DIR!, chain: CHAIN });
      const result = await cards.buy(q.quote_id, { refundTo: await buyer.unifiedAddress() });
      run.txid = result.txid ?? run.txid; run.stage = result.status === 'delivered' ? 'delivered' : result.status === 'buying' ? 'buying' : 'failed';
      run.code = result.code; run.result = { receipt_id: result.receipt_id, invoice_id: result.invoice_id, order_id: result.order_id, code_masked: maskRedemption(result.code) };
      emit(result.status, result.status === 'delivered' ? 'Card delivered' : 'Card pending or failed');
    } catch (e) { run.stage = 'failed'; run.error = errMsg(e); emit('failed', run.error); }
  })();
  res.json({ run_id: id });
});
app.get('/api/relay/runs/:id', (req, res) => {
  const run = relayRuns.get(String(req.params.id)); if (!run) return res.status(404).json({ error: 'Run not found' });
  const { code: _code, ...safe } = run; res.json(safe);
});
app.get('/api/relay/runs/:id/code', (req, res) => {
  if (!localOnly(req.socket.remoteAddress)) return res.status(403).json({ error: 'Local only' });
  const code = relayRuns.get(String(req.params.id))?.code; if (!code) return res.status(404).json({ error: 'Code unavailable' });
  res.json(code);
});
let agentCards: ReturnType<typeof buyerCards> | undefined;
async function handleCards() { const gateway = await sellerNymAddress(); if (!gateway) throw new Error('Setup required: OBORO_SELLER_NYM_ADDRESS'); return agentCards ??= buyerCards(gateway); }
const relay: RelayHandle = {
  catalog: async () => (await handleCards()).catalog(),
  quote: async (product_id, value) => (await handleCards()).quote(product_id, value),
  buy: async (quote_id) => (await handleCards()).buy(quote_id),
  receipt: async (id) => (await handleCards()).receipt(id),
};
const exampleAgent = createShoppingAgent({
  relay,
  budget: () => ({ spentTodayZats: spentToday(),
    remainingTodayZats: Math.max(0, DAILY - spentToday()), dailyCapZats: DAILY, maxPerPaymentZats: MAX_PER }),
});
let chatBusy = false;
app.post('/api/examples/shopping-agent/chat', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'Say something to the example agent' });
  if (chatBusy) return res.status(409).json({ error: 'the example agent is still thinking about the last message' });
  chatBusy = true;
  try {
    res.json(await exampleAgent.chat(String(req.body?.sessionId ?? ''), message));
  } catch (e) {
    res.status(502).json({ error: errMsg(e) });
  } finally {
    chatBusy = false;
  }
});

app.get('/api/examples/shopping-agent/source', (_req, res) => {
  const source = readFileSync(join(repo, 'examples/shopping-agent/agent.ts'), 'utf8');
  res.json({ file: 'examples/shopping-agent/agent.ts', lines: source.split('\n').length - Number(source.endsWith('\n')),
    source });
});

// Operator approval for a parked over-cap purchase: a human presses Approve on this machine (local only).
app.post('/api/operator/approve', async (req, res) => {
  const ip = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'Operator actions are local only' });
  const runId = String(req.body?.runId ?? '');
  const approvalId = approvals.get(runId);
  if (!approvalId) return res.status(404).json({ error: 'Nothing waiting for approval' });
  try {
    const { ShopLedger } = await import('../../packages/shop/dist/index.js');
    const record = await new ShopLedger(resolve(repo, process.env.OBORO_SHOP_LEDGER ?? '.oboro/shop.json')).approve(approvalId);
    approvals.delete(runId);
    res.json({ approved: true, product_id: record.product_id, value: record.value, usd: record.usd });
  } catch (e) {
    res.status(409).json({ error: errMsg(e) });
  }
});

// Setup card: the operator pastes the Bitrefill key and phone here (localhost only). They go straight into the
// gitignored .env (mode 600) and are never echoed back; gateway is restarted so its Bitrefill client picks them up.
app.post('/api/setup/shop', async (req, res) => {
  const ip = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'Setup is local only' });
  const updates: Record<string, string> = {};
  const key = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  const phone = typeof req.body?.phone === 'string' ? req.body.phone.replace(/[\s-]/g, '') : '';
  if (key) { if (!/^[A-Za-z0-9._-]{16,200}$/.test(key)) return res.status(400).json({ error: 'That does not look like a Bitrefill API key' }); updates.BITREFILL_API_KEY = key; }
  if (phone) { if (!/^\+[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ error: 'Phone must be international, e.g. +91 98xxxxxxxx' }); updates.OBORO_SHOP_PHONE = phone; }
  if (req.body?.liveBuy === true) updates.OBORO_BITREFILL_LIVE_BUY = '1';
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to save' });
  const lines = existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n') : [];
  for (const [k, v] of Object.entries(updates)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`);
    process.env[k] = v;
  }
  writeFileSync(envFile, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  chmodSync(envFile, 0o600);
  const restarted = updates.BITREFILL_API_KEY || updates.OBORO_BITREFILL_LIVE_BUY ? restartGateway() : false;
  res.json({ saved: Object.keys(updates), restartedGateway: restarted });
});

function restartGateway(): boolean {
  const pidsFile = join(repo, '.oboro/pids');
  if (!existsSync(pidsFile)) return false;
  const rows = readFileSync(pidsFile, 'utf8').trim().split('\n').map((l) => l.split(' '));
  const old = rows.find((r) => r[1] === 'gateway');
  if (old) { try { execFileSync('pkill', ['-TERM', '-P', old[0]]); } catch { /* no children */ } try { process.kill(Number(old[0])); } catch { /* gone */ } }
  const log = openSync(join(repo, '.oboro/logs/gateway.log'), 'a', 0o600);
  const child = spawn('pnpm', ['--filter', '@oboro/gateway', 'exec', 'tsx', 'src/gateway.ts'], { cwd: repo, env: process.env, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  writeFileSync(pidsFile, [...rows.filter((r) => r[1] !== 'gateway'), [String(child.pid), 'gateway']].map((r) => r.join(' ')).join('\n') + '\n');
  return true;
}

// Production: serve the built dashboard from the same origin.
const dist = join(here, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ console: `http://127.0.0.1:${PORT}` })));
