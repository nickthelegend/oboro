// Client for the relay endpoints of the wallet server (apps/wallet/server.ts → gateway over Nym).
// Every number on the relay pages comes from here. When the relay can't be reached the pages say so.
import { useEffect, useRef, useState } from 'react';

export type RelayPackage = { value: string; usd: number; zats: number; available: boolean; reason?: string };
export type RelayProduct = { product_id: string; name: string; currency: string; in_stock: boolean; packages: RelayPackage[] };
export type RelaySale = {
  name?: string; product_id?: string; value: string; currency?: string; usd: number; zats: number; zec_usd: number;
  txid: string; status: string; created_at: string; delivered_at?: string; invoice_id?: string;
};
export type RelayState = {
  setup: string[];
  error?: string;
  rate?: { usd: number; source: string; at: string };
  float_usd?: number;
  limits?: { max_usd_per_sale: number; max_usd_per_day: number; sold_today_usd: number };
  products: RelayProduct[];
  sales: RelaySale[];
  relay_knows: string[];
  relay_never_saw: string[];
};
export type RelayRun = {
  stage: 'quote' | 'paying' | 'paid' | 'verifying' | 'buying' | 'delivered' | 'failed';
  quote?: { product_id: string; name: string; value: string; currency: string; usd: number; zats: number; zec_usd: number; expires_at: string };
  txid?: string;
  events: { at: string; type: string; text: string }[];
  result?: { receipt_id: string; invoice_id: string; order_id: string; code_masked?: Record<string, string> };
  error?: string;
};

const EMPTY: RelayState = { setup: [], products: [], sales: [], relay_knows: [], relay_never_saw: [] };

function normalise(raw: Record<string, unknown>): RelayState {
  const catalog = (raw.catalog ?? raw) as Record<string, unknown>;
  const relay = (raw.relay ?? raw) as Record<string, unknown>;
  const list = <T,>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
  return {
    setup: [...new Set([...list<string>(raw.setup), ...list<string>(catalog.setup)])],
    error: typeof raw.error === 'string' ? raw.error : undefined,
    rate: (catalog.rate ?? relay.rate) as RelayState['rate'],
    float_usd: (catalog.float_usd ?? relay.float_usd) as number | undefined,
    limits: catalog.limits as RelayState['limits'],
    products: list<RelayProduct>(catalog.products),
    sales: list<RelaySale>(relay.sales),
    relay_knows: list<string>(relay.relay_knows),
    relay_never_saw: list<string>(relay.relay_never_saw),
  };
}

export function useRelay(every = 15000) {
  const [state, setState] = useState<RelayState>(EMPTY);
  const [status, setStatus] = useState<'loading' | 'ok' | 'offline'>('loading');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/relay');
        const body = (await r.json()) as Record<string, unknown>;
        if (!alive) return;
        setState(normalise(body));
        setStatus(r.ok ? 'ok' : 'offline');
      } catch {
        if (alive) setStatus('offline');
      }
    };
    void load();
    const t = setInterval(load, every);
    return () => { alive = false; clearInterval(t); };
  }, [every]);
  return { state, status };
}

export async function startBuy(product_id: string, value: string): Promise<string> {
  const r = await fetch('/api/relay/buy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id, value }) });
  const body = (await r.json().catch(() => ({}))) as { run_id?: string; error?: string };
  if (!r.ok || !body.run_id) throw new Error(body.error ?? `The relay answered HTTP ${r.status}`);
  return body.run_id;
}

export function useRun(id: string | null) {
  const [run, setRun] = useState<RelayRun | null>(null);
  const done = useRef(false);
  useEffect(() => {
    if (!id) { setRun(null); return; }
    done.current = false;
    let alive = true;
    const tick = async () => {
      if (done.current) return;
      try {
        const r = await fetch(`/api/relay/runs/${id}`);
        const body = (await r.json()) as RelayRun;
        if (!alive) return;
        setRun(body);
        if (body.stage === 'delivered' || body.stage === 'failed') done.current = true;
      } catch { /* keep polling; the stage list shows the last known stage */ }
    };
    void tick();
    const t = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [id]);
  return run;
}

// ---- formatting -------------------------------------------------------------------------------------------------
export const zecOf = (zats: number) => (zats / 1e8).toFixed(6);
export const usd = (n: number) => `$${n.toFixed(2)}`;
export const inr = (v: string | number, currency = 'INR') => (currency === 'INR' ? `₹${Number(v).toLocaleString('en-IN')}` : `${v} ${currency}`);
export const shortTx = (tx: string) => (tx.includes('…') ? tx : `${tx.slice(0, 8)}…${tx.slice(-6)}`);
export const explorerTx = (tx: string) => `https://testnet.zcashexplorer.app/transactions/${tx}`;
export function ago(iso?: string) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
// Card faces: a tint per product family so the catalog reads at a glance. Names are shown as text, never logos.
export function tint(id: string): [string, string] {
  if (id.startsWith('blink')) return ['#f7d046', '#1f7a3a'];
  if (id.startsWith('swiggy')) return ['#ff8a3d', '#a8321b'];
  if (id.startsWith('amazon')) return ['#ffb84d', '#232f3e'];
  return ['#9ec5ff', '#3b4a7a'];
}
