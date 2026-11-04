// Oboro console server: the only backend the dashboard talks to.
// It reads live status from the two oboro-node processes and Tsuki, and runs Kumo (the buyer agent)
// through the real SDK when you press a button. Nothing here is simulated: if a piece is down, /api/state says so.
import express from 'express';
import { chmodSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
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
        return push({ ts, type: 'pending', detail: 'Tsuki answers 402 payment_pending until its viewing key sees the mined note (NU7 testnet blocks ≈ 25 s)' });
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

// ───────────────────────── Shop: Kumo buys a real thing through Tsuki's Bitrefill shop ─────────────────────────
// Every step crosses the Nym mixnet: browse (free), quote (free), then a paid POST whose shielded payment
// authorises one Bitrefill purchase that Tsuki pays from its event credits. Codes never reach this UI unmasked.
type ShopStep = { ts: string; type: string; detail?: string; txid?: string; zats?: number; usd?: number; mixMs?: number; status?: number };
type ShopRun = {
  id: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'delivered' | 'processing' | 'needs_approval' | 'refused' | 'failed';
  product?: { id: string; name: string; value: string; currency: string; usd: number };
  phoneMasked?: string; txid?: string; invoiceId?: string; orderId?: string; receiptId?: string;
  redemptionMasked?: Record<string, string>; steps: ShopStep[]; error?: string;
};
const shopRuns: ShopRun[] = [];
const maskValue = (v: string) => (v.length <= 4 ? '•'.repeat(v.length) : `${v.slice(0, 2)}${'•'.repeat(Math.min(10, v.length - 4))}${v.slice(-2)}`);
const maskRedemption = (r: unknown): Record<string, string> | undefined => {
  if (!r || typeof r !== 'object') return undefined;
  return Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [k, k === 'instructions' ? 'present' : maskValue(String(v))]));
};
const maskPhone = (p?: string) => (p ? `${p.slice(0, 3)} ••••• ${p.slice(-4)}` : undefined);

async function viaNym(tsuki: string, path: string, init: RequestInit = {}) {
  const started = Date.now();
  const res = await fetch(`${TUNNEL}/nym/${encodeURIComponent(tsuki)}${path}`, { ...init, signal: AbortSignal.timeout(130_000) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body as Record<string, unknown>, mixMs: Number(res.headers.get('x-oboro-mix-ms')) || Date.now() - started };
}

app.get('/api/shop', async (_req, res) => {
  const shop = await getJson<Record<string, unknown>>(`${SELLER}/oboro/shop`).catch((e) => ({ error: errMsg(e) }));
  const setup: string[] = [];
  if (!process.env.OBORO_SHOP_PHONE) setup.push('OBORO_SHOP_PHONE');
  res.json({ tsuki: shop, consoleSetup: setup, phoneMasked: maskPhone(process.env.OBORO_SHOP_PHONE), runs: shopRuns.slice(0, 10) });
});

// Free catalog read through the mixnet, cached for a minute: the Shop page's live quote before any errand.
let quoteCache: { at: number; body?: unknown; mixMs?: number; error?: string } = { at: 0 };
app.get('/api/shop/quote', async (_req, res) => {
  if (Date.now() - quoteCache.at < 60_000 && (quoteCache.body || quoteCache.error)) return res.json({ ...quoteCache, cached: true });
  const tsuki = await sellerNymAddress();
  if (!tsuki) return res.status(412).json({ error: 'Setup required: Tsuki’s gate is not running (no Nym address)' });
  try {
    const q = await viaNym(tsuki, '/v1/shop/product/airtel-india');
    quoteCache = q.status === 200 ? { at: Date.now(), body: q.body, mixMs: q.mixMs } : { at: Date.now(), error: String(q.body.error ?? `HTTP ${q.status}`) };
  } catch (e) {
    quoteCache = { at: Date.now(), error: errMsg(e) };
  }
  res.json({ ...quoteCache, cached: false });
});

app.post('/api/shop/run', async (req, res) => {
  const productId = String(req.body?.product_id ?? 'airtel-india');
  const value = String(req.body?.value ?? '10');
  if (!/^[a-z0-9-]{1,100}$/.test(productId) || !/^\d+(\.\d+)?$/.test(value)) return res.status(400).json({ error: 'product_id and value are required' });
  if (runs.some((r) => r.status === 'running') || shopRuns.some((r) => r.status === 'running')) return res.status(409).json({ error: 'Kumo is already paying for something' });
  const buyerDir = process.env.OBORO_BUYER_WALLET_DIR;
  if (!buyerDir) return res.status(412).json({ error: 'Setup required: OBORO_BUYER_WALLET_DIR' });
  const phone = process.env.OBORO_SHOP_PHONE;
  if (productId === 'airtel-india' && !phone) return res.status(412).json({ error: 'Setup required: a phone number for the top-up (Setup card)' });
  const tsuki = await sellerNymAddress();
  if (!tsuki) return res.status(412).json({ error: 'Setup required: Tsuki’s gate is not running (no Nym address)' });

  const run: ShopRun = { id: randomUUID(), startedAt: new Date().toISOString(), status: 'running', phoneMasked: maskPhone(phone), steps: [] };
  shopRuns.unshift(run);
  res.json({ id: run.id });
  const push = (s: Omit<ShopStep, 'ts'>) => run.steps.push({ ts: new Date().toISOString(), ...s });

  try {
    // 1. Browse Tsuki's catalog (free). Tsuki reads it from Bitrefill.
    push({ type: 'browse', detail: `GET nym://Tsuki/v1/shop/search?q=${productId.split('-')[0]}` });
    const search = await viaNym(tsuki, `/v1/shop/search?q=${encodeURIComponent(productId.split('-')[0])}`);
    if (search.status !== 200) throw new Error(`Catalog search failed: ${String(search.body.error ?? search.status)}`);
    const found = (search.body.products as { id: string; name: string; in_stock: boolean }[] | undefined) ?? [];
    push({ type: 'browsed', mixMs: search.mixMs, detail: `${found.length} Bitrefill products; ${found.some((p) => p.id === productId) ? `${productId} in the list` : `${productId} not in the first page`}` });

    // 2. Quote: the package's USD price comes from Bitrefill, never from the request.
    const quote = await viaNym(tsuki, `/v1/shop/product/${productId}`);
    if (quote.status !== 200) throw new Error(`Product lookup failed: ${String(quote.body.error ?? quote.status)}`);
    const pkgs = (quote.body.packages as { value: string; usd: number; currency: string }[] | undefined) ?? [];
    const pkg = pkgs.find((p) => String(p.value) === value);
    if (!pkg) throw new Error(`${productId} has no ${value} package`);
    if (quote.body.in_stock === false) throw new Error(`${productId} is out of stock`);
    run.product = { id: productId, name: String(quote.body.name ?? productId), value, currency: pkg.currency || String(quote.body.currency ?? ''), usd: pkg.usd };
    push({ type: 'quoted', usd: pkg.usd, mixMs: quote.mixMs, detail: `${run.product.name}: ${value} ${run.product.currency} = $${pkg.usd.toFixed(2)} (Bitrefill price)` });

    // 3. Pay Tsuki in shielded ZEC over Nym; the paid POST is the purchase authorisation.
    const agent = createAgent({
      tunnelUrl: TUNNEL,
      wallet: new ZingoWallet({ dataDir: buyerDir }),
      policy: { maxPerRequestZats: MAX_PER, dailyCapZats: DAILY, allowRecipients: [tsuki] },
      spendFile: SPEND_FILE,
      onEvent: (e: AgentEvent) => {
        switch (e.type) {
          case 'payment_required': return push({ type: 'payment_required', zats: e.amountZats, detail: 'Tsuki asks for a shielded payment to authorise the purchase' });
          case 'policy_ok': return push({ type: 'policy_ok', zats: e.amountZats, detail: `Kumo’s policy: ≤ ${MAX_PER.toLocaleString('en-US')} zats per call, ${DAILY.toLocaleString('en-US')} per day, Tsuki only` });
          case 'policy_refused': return push({ type: 'policy_refused', detail: e.reason });
          case 'paying': return push({ type: 'paying', zats: e.amountZats, detail: 'zingo-cli quicksend, broadcast over the Nym mixnet' });
          case 'paid': run.txid = e.txid; return push({ type: 'paid', txid: e.txid, detail: `txid ${e.txid.slice(0, 16)}…` });
          case 'pending': if (run.steps[run.steps.length - 1]?.type === 'pending') return; return push({ type: 'pending', detail: 'Waiting for Tsuki’s viewing key to see the mined note (NU7 blocks ≈ 25 s)' });
          case 'settled': return push({ type: 'settled', detail: 'Tsuki verified amount, memo and nonce; txid reserved before any Bitrefill call' });
          default: return;
        }
      },
    });
    push({ type: 'request', detail: `POST nym://Tsuki/v1/shop/buy {${productId}, ${value}${phone ? ', phone' : ''}}` });
    const buy = await agent.fetch(`nym://${tsuki}/v1/shop/buy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: productId, value, ...(phone ? { phone_number: phone } : {}) }) });
    let body = (await buy.json().catch(() => ({}))) as Record<string, unknown>;
    let status = buy.status;
    push({ type: 'bitrefill', status, detail: status === 200 ? 'Bitrefill invoice paid from Tsuki’s balance; order delivered' : `Tsuki answered ${status} ${String(body.status ?? body.code ?? '')}` });

    // 4. Long fulfilment: poll the receipt (free, bearer receipt id) until delivered.
    const deadline = Date.now() + 5 * 60_000;
    while (status === 202 && body.status === 'processing' && body.receipt_id && Date.now() < deadline) {
      run.receiptId = String(body.receipt_id);
      push({ type: 'processing', detail: 'Bitrefill order processing; polling the receipt over Nym' });
      await new Promise((r) => setTimeout(r, 5000));
      const r = await viaNym(tsuki, `/v1/shop/receipt/${run.receiptId}`);
      status = r.status; body = r.body;
    }
    if (status === 200 && body.status === 'delivered') {
      run.status = 'delivered';
      run.invoiceId = String(body.invoice_id ?? '');
      run.orderId = String(body.order_id ?? '');
      run.redemptionMasked = maskRedemption(body.redemption);
      push({ type: 'delivered', usd: Number(body.usd) || run.product.usd, detail: `Invoice ${run.invoiceId} · order ${run.orderId} delivered` });
    } else if (status === 202 && body.status === 'needs_approval') {
      run.status = 'needs_approval';
      push({ type: 'needs_approval', detail: 'Above the caps: nothing bought. A human approves out of band with pnpm --filter @oboro/agents shop:approve <id>' });
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
});

// Setup card: the operator pastes the Bitrefill key and phone here (localhost only). They go straight into the
// gitignored .env (mode 600) and are never echoed back; Tsuki is restarted so its Bitrefill client picks them up.
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
  const restarted = updates.BITREFILL_API_KEY || updates.OBORO_BITREFILL_LIVE_BUY ? restartTsuki() : false;
  res.json({ saved: Object.keys(updates), restartedTsuki: restarted });
});

function restartTsuki(): boolean {
  const pidsFile = join(repo, '.oboro/pids');
  if (!existsSync(pidsFile)) return false;
  const rows = readFileSync(pidsFile, 'utf8').trim().split('\n').map((l) => l.split(' '));
  const old = rows.find((r) => r[1] === 'tsuki');
  if (old) { try { execFileSync('pkill', ['-TERM', '-P', old[0]]); } catch { /* no children */ } try { process.kill(Number(old[0])); } catch { /* gone */ } }
  const log = openSync(join(repo, '.oboro/logs/tsuki.log'), 'a', 0o600);
  const child = spawn('pnpm', ['--filter', '@oboro/agents', 'exec', 'tsx', 'src/seller.ts'], { cwd: repo, env: process.env, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  writeFileSync(pidsFile, [...rows.filter((r) => r[1] !== 'tsuki'), [String(child.pid), 'tsuki']].map((r) => r.join(' ')).join('\n') + '\n');
  return true;
}

// Production: serve the built dashboard from the same origin.
const dist = join(here, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ console: `http://127.0.0.1:${PORT}` })));
