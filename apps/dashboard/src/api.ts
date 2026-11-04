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

export const explorer = (txid: string) => `https://zexplorer.app/testnet/tx/${txid}`;
