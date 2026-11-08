// Client for the relay endpoints of the wallet server (apps/wallet/server.ts → gateway over Nym).
// Every number on the relay pages comes from here. When the relay can't be reached the pages say so.
import { useEffect, useRef, useState } from 'react';

export type RelayPackage = { value: string; usd: number; zats: number; available: boolean; reason?: string; amount?: number };
export type RelayKind = 'card' | 'recharge';
export type RelayProduct = { product_id: string; name: string; currency: string; in_stock: boolean; kind?: RelayKind; packages: RelayPackage[] };
export type RelaySale = {
  name?: string; product_id?: string; value: string; currency?: string; usd: number; zats: number; zec_usd: number;
  txid: string; status: string; created_at: string; delivered_at?: string; invoice_id?: string; kind?: RelayKind; phone_masked?: string;
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
  recharge_note?: string;
  captured_at?: string;
};
export type RelayRun = {
  stage: 'quote' | 'paying' | 'paid' | 'verifying' | 'buying' | 'delivered' | 'failed';
  quote?: { product_id: string; name: string; value: string; currency: string; usd: number; zats: number; zec_usd: number; expires_at: string; kind?: RelayKind; amount?: number };
  txid?: string;
  events: { at: string; type: string; text: string }[];
  result?: { receipt_id: string; invoice_id: string; order_id: string; code_masked?: Record<string, string>; kind?: RelayKind; phone_masked?: string; amount?: number };
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
    recharge_note: typeof relay.recharge_note === 'string' ? relay.recharge_note : undefined,
    captured_at: typeof raw.captured_at === 'string' ? raw.captured_at : undefined,
  };
}

export type RelayStatus = 'loading' | 'ok' | 'offline' | 'snapshot';
export const stamp = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : '');

export function useRelay(every = 15000) {
  const [state, setState] = useState<RelayState>(EMPTY);
  const [status, setStatus] = useState<RelayStatus>('loading');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/relay');
        const body = (await r.json()) as Record<string, unknown>;
        if (!alive) return;
        if (r.ok) { setState(normalise(body)); setStatus('ok'); return; }
        throw new Error('relay unreachable');
      } catch {
        // Where the relay can't be reached over Nym (the hosted copy), show the dated snapshot of its public data.
        try {
          const s = await fetch('/relay-snapshot.json');
          if (!s.ok) throw new Error('no snapshot');
          if (alive) { setState(normalise((await s.json()) as Record<string, unknown>)); setStatus('snapshot'); }
        } catch { if (alive) setStatus('offline'); }
      }
    };
    void load();
    const t = setInterval(load, every);
    return () => { alive = false; clearInterval(t); };
  }, [every]);
  return { state, status };
}

export async function startBuy(product_id: string, value: string, phone_number?: string): Promise<string> {
  const r = await fetch('/api/relay/buy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id, value, ...(phone_number ? { phone_number } : {}) }) });
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

// The opened code lives only in the local wallet server (localhost-only endpoint). The page asks for it on demand.
export async function fetchCode(runId: string): Promise<Record<string, string>> {
  const r = await fetch(`/api/relay/runs/${encodeURIComponent(runId)}/code`);
  const body = (await r.json().catch(() => ({}))) as Record<string, string> & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

// ---- formatting -------------------------------------------------------------------------------------------------
export const zecOf = (zats: number) => (zats / 1e8).toFixed(6);
export const usd = (n: number) => `$${n.toFixed(2)}`;
export const inr = (v: string | number, currency = 'INR') => (!Number.isFinite(Number(v)) ? String(v) : currency === 'INR' ? `₹${Number(v).toLocaleString('en-IN')}` : `${v} ${currency}`);
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
export const kindOf = (p?: { kind?: RelayKind; product_id?: string }) => p?.kind ?? (/-bundles(-india)?$|^airtel-india$|^vi-india$/.test(p?.product_id ?? '') ? 'recharge' : 'card');
// Bitrefill plan names look like "1.5GB/Day – 28 Days"; split them into the allowance and the validity for display.
export function plan(value: string) {
  const m = value.match(/^(.*?)\s+–\s+(\d+)\s+Days?$/i);
  return m ? { data: m[1].replace(/\/Day/i, ' / day'), days: Number(m[2]) } : { data: value, days: undefined as number | undefined };
}
export const operator = (name: string) => name.replace(/ Bundles India$| India$/, '').replace(/^Reliance /, '');
export const priceLabel = (pkg: { value: string; amount?: number }, currency = 'INR') => (pkg.amount !== undefined ? inr(pkg.amount, currency) : inr(pkg.value, currency));
// India mobile numbers: 10 digits starting 6–9.
export const validIndianMobile = (digits: string) => /^[6-9]\d{9}$/.test(digits);
export const maskTail = (digits: string) => `+91 ••••• •••${digits.slice(-2)}`;

// Card faces: a tint per product family so the catalog reads at a glance. Names are shown as text, never logos.
export function tint(id: string): [string, string] {
  if (id.startsWith('blink')) return ['#f7d046', '#1f7a3a'];
  if (id.startsWith('swiggy')) return ['#ff8a3d', '#a8321b'];
  if (id.startsWith('amazon')) return ['#ffb84d', '#232f3e'];
  if (id.startsWith('reliance-jio')) return ['#5b8cff', '#0a2a8a'];
  if (id.startsWith('airtel')) return ['#ff6b6b', '#8a0f1d'];
  return ['#9ec5ff', '#3b4a7a'];
}
