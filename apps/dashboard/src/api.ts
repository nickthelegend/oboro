// Client for the Oboro console server (apps/dashboard/server.ts).
// Everything shown in the UI comes from here; when the server or a node is down the UI says so.

export type NodeStatus = {
  ok: boolean;
  nymAddress?: string;
  served?: number;
  errors?: number;
  startedAt?: string;
  error?: string;
};

export type AgentEvent = {
  ts: string;
  type: string; // request | payment_required | policy_ok | policy_refused | paying | paid | pending | settled | response | error
  detail?: string;
  txid?: string;
  zats?: number;
  mixMs?: number;
  status?: number;
};

export type Run = {
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
  events: AgentEvent[];
  response?: string;
  error?: string;
};

export type GateEvent = {
  seq: number;
  ts: string;
  kind: string;
  streamId?: string;
  method?: string;
  path?: string;
  status?: number;
  bytesIn?: number;
  bytesOut?: number;
  ms?: number;
  senderVisible?: string;
};

export type LedgerRow = {
  ts: string;
  path: string;
  priceZats: number;
  txid?: string;
  height?: number;
  status: string;
  viaMixnet: boolean;
};

export type ConsoleState = {
  server: 'ok';
  network: 'zcash-testnet';
  setup: string[];
  tunnel: NodeStatus;
  gate: NodeStatus;
  buyer: {
    ok: boolean;
    balanceZats?: number;
    balanceAt?: string;
    spentTodayZats?: number;
    dailyCapZats?: number;
    maxPerRequestZats?: number;
    error?: string;
  };
  seller: {
    ok: boolean;
    payTo?: string;
    ledger: LedgerRow[];
    gateEvents: GateEvent[];
    error?: string;
  };
  catalog: { endpoint: string; path: string; priceZats: number; description: string }[];
  runs: Run[];
};

export async function getState(signal?: AbortSignal): Promise<ConsoleState> {
  const res = await fetch('/api/state', { signal });
  if (!res.ok) throw new Error(`console server answered ${res.status}`);
  return res.json();
}

export async function startRun(endpoint: string): Promise<{ id: string }> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `run refused (${res.status})`);
  return body;
}

export const short = (s?: string, a = 8, b = 6) =>
  !s ? '—' : s.length <= a + b + 1 ? s : `${s.slice(0, a)}…${s.slice(-b)}`;

export const zec = (zats?: number) =>
  zats === undefined ? '—' : (zats / 1e8).toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 8 });

// testnet.zcashexplorer.app indexes NU7 testnet; Zexplorer's testnet index is stale (see FEEDBACK.md).
export const explorer = (txid: string) => `https://testnet.zcashexplorer.app/transactions/${txid}`;

// ───────── Shop (Bitrefill through Tsuki) ─────────
export type ShopStep = { ts: string; type: string; detail?: string; txid?: string; zats?: number; usd?: number; mixMs?: number; status?: number };
export type ShopRun = {
  id: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'delivered' | 'processing' | 'needs_approval' | 'refused' | 'failed';
  product?: { id: string; name: string; value: string; currency: string; usd: number };
  phoneMasked?: string; txid?: string; invoiceId?: string; orderId?: string;
  redemptionMasked?: Record<string, string>; steps: ShopStep[]; error?: string;
};
export type ShopPurchase = { txid: string; status: string; product_id: string; value: string; usd: number; phone_masked?: string; invoice_id?: string; order_ids: string[]; code_masked?: Record<string, unknown>; created_at: string; updated_at: string };
export type ShopState = {
  tsuki: { ledger?: ShopPurchase[]; guardrails?: { allow: { product_id: string; values: (string | number)[] }[]; maxUsdPerPurchase: number; maxUsdPerDay: number; maxPurchasesPerDay: number }; today?: { usd: number; count: number }; setup?: string[]; error?: string };
  consoleSetup: string[];
  phoneMasked?: string;
  runs: ShopRun[];
};
export async function getShop(signal?: AbortSignal): Promise<ShopState> {
  const res = await fetch('/api/shop', { signal });
  if (!res.ok) throw new Error(`console server answered ${res.status}`);
  return res.json();
}
export async function startShopRun(product_id: string, value: string): Promise<{ id: string }> {
  const res = await fetch('/api/shop/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id, value }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `run refused (${res.status})`);
  return body;
}
export async function saveShopSetup(input: { apiKey?: string; phone?: string; liveBuy?: boolean }): Promise<{ saved: string[]; restartedTsuki: boolean }> {
  const res = await fetch('/api/setup/shop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `setup refused (${res.status})`);
  return body;
}

export type ToolTrace = { name: string; args: Record<string, unknown>; summary: string; ok: boolean; mixMs?: number };
export type ChatTurn = { role: 'user' | 'assistant'; text: string; tools?: ToolTrace[]; runId?: string; at: string };
export async function chatKumo(sessionId: string, message: string): Promise<{ sessionId: string; turns: ChatTurn[] }> {
  const res = await fetch('/api/agent/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, message }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Kumo is unavailable (${res.status})`);
  return body;
}
