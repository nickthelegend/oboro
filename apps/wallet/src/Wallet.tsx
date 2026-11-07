import { useEffect, useRef, useState } from 'react';
import { chainName, explorer, getShop, saveShopSetup, short, zec, type ShopRun, type ShopState } from './api';
import { Nav } from './chrome';
import { useConsole } from './useConsole';

/** Polls /api/shop (merchant gateway rules, ledger and live purchase runs). */
export function useShop(intervalMs = 2000) {
  const [shop, setShop] = useState<ShopState | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const tick = async () => {
      try {
        const s = await getShop(ctrl.signal);
        if (alive) { setShop(s); setOffline(null); }
      } catch (e) {
        if (alive) setOffline(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer.current = window.setTimeout(tick, intervalMs);
    };
    tick();
    return () => { alive = false; ctrl.abort(); window.clearTimeout(timer.current); };
  }, [intervalMs]);
  return { shop, offline };
}

const SETUP_LABEL: Record<string, string> = {
  BITREFILL_API_KEY: 'Bitrefill API key',
  'OBORO_BITREFILL_LIVE_BUY=1': 'live purchases switched on',
  OBORO_SHOP_PHONE: 'a phone to top up',
};

type Activity = { key: string; kind: 'buy' | 'api'; title: string; sub: string; amount: string; status: string; at: string; txid?: string };

const productName = (id: string) =>
  id.replace(/-india(-bundles)?$/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};
export const statusTone = (s: string) =>
  s === 'delivered' || s === 'paid' ? 'paid' : s === 'running' || s === 'processing' || s === 'reserved' ? 'running' : s === 'needs_approval' ? 'warn' : 'failed';

export function Wallet() {
  const { state, offline } = useConsole(4000);
  const { shop } = useShop(2500);
  const w = state?.wallet;
  const g = shop?.gateway.guardrails;
  const today = shop?.gateway.today;
  const setup = [...(shop?.gateway.setup ?? []), ...(shop?.consoleSetup ?? [])];
  const waiting = (shop?.runs ?? []).filter((r) => r.status === 'needs_approval');
  const spent = w?.spentTodayZats ?? 0;
  const cap = w?.dailyCapZats ?? 0;
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
  const unit = chainName() === 'mainnet' ? 'ZEC' : 'TAZ';

  // A purchase is paid by one x402 call to /v1/shop/buy: show it once, with the full txid from the payment ledger.
  const payments = state?.gateway.ledger ?? [];
  const fullTx = (masked: string) => {
    const [a, b] = masked.split('…');
    return payments.find((r) => r.txid && b !== undefined && r.txid.startsWith(a) && r.txid.endsWith(b))?.txid;
  };
  const buys = (shop?.gateway.ledger ?? []).map((p) => ({ ...p, fullTxid: fullTx(p.txid) }));
  const buyTx = new Set(buys.map((b) => b.fullTxid).filter(Boolean));
  const activity: Activity[] = [
    ...buys.map((p) => ({
      key: `b-${p.txid}-${p.created_at}`,
      kind: 'buy' as const,
      title: `${productName(p.product_id)} · ₹${p.value}`,
      sub: p.invoice_id ? `Bitrefill invoice ${short(p.invoice_id, 8, 4)}` : p.status === 'needs_approval' ? 'Waiting for your approval' : 'Through the merchant gateway',
      amount: `$${p.usd.toFixed(2)}`,
      status: p.status,
      at: p.created_at,
      txid: p.fullTxid,
    })),
    ...payments
      .filter((r) => !buyTx.has(r.txid))
      .map((r) => ({
        key: `a-${r.txid}`,
        kind: 'api' as const,
        title: `Paid API call · ${r.path}`,
        sub: 'x402 over the Nym mixnet',
        amount: `${r.priceZats.toLocaleString('en-US')} zats`,
        status: r.status,
        at: r.ts,
        txid: r.txid,
      })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 10);

  return (
    <div className="page">
      <Nav active="wallet" />
      <main className="app">
        <header className="app-head">
          <h1>Wallet</h1>
          <p>Shielded Zcash, spent over the Nym mixnet, only inside the limits you set here.</p>
        </header>

        {offline && (
          <div className="notice" role="status">
            <strong>Setup required.</strong> Live balances come from the wallet server on the operator’s machine; this page
            can’t reach one. <span className="mono fine">({offline})</span>
          </div>
        )}
        {setup.length > 0 && <SetupCard missing={setup} />}

        <div className="wallet-grid">
          <div className="wallet-col">
            <section className="balance-card" aria-label="Balance">
              <div className="balance-top">
                <span className="balance-label">Shielded balance</span>
                <span className="balance-net mono">Zcash {chainName()}</span>
              </div>
              <div className="balance-num">
                {w?.balanceZats !== undefined ? zec(w.balanceZats) : '—'}
                <small>{unit}</small>
              </div>
              {!w?.ok && <p className="balance-note">{w?.error ?? 'Setup required: OBORO_BUYER_WALLET_DIR'}</p>}
              <div className="meter" aria-label="Spent today">
                <div className="meter-row">
                  <span>Spent today</span>
                  <span className="mono">
                    {spent.toLocaleString('en-US')} / {cap ? cap.toLocaleString('en-US') : '—'} zats
                  </span>
                </div>
                <div className="meter-bar"><span style={{ width: `${pct}%` }} /></div>
              </div>
              <dl className="balance-rows">
                <div><dt>Per payment</dt><dd className="mono">≤ {w?.maxPerRequestZats?.toLocaleString('en-US') ?? '—'} zats</dd></div>
                <div><dt>Pays only</dt><dd>the merchant gateway</dd></div>
                <div><dt>Route</dt><dd>Nym mixnet · no IP</dd></div>
              </dl>
            </section>

            <section className="card" aria-label="Approvals">
              <div className="card-head">
                <h2>Needs your approval</h2>
                {waiting.length > 0 && <span className="count">{waiting.length}</span>}
              </div>
              {waiting.length === 0 ? (
                <p className="empty">Nothing waiting. Anything over your limits stops here first, and nothing is bought until you say so.</p>
              ) : (
                waiting.map((r) => <ApprovalRow key={r.id} run={r} />)
              )}
            </section>

            <section className="card" aria-label="Limits">
              <div className="card-head"><h2>Merchant limits</h2><span className="fine">Bitrefill connector</span></div>
              {g ? (
                <dl className="limits">
                  <div><dt>Per purchase</dt><dd className="mono">≤ ${g.maxUsdPerPurchase.toFixed(2)}</dd></div>
                  <div><dt>Per day</dt><dd className="mono">≤ ${g.maxUsdPerDay.toFixed(2)} · {g.maxPurchasesPerDay} buys</dd></div>
                  <div><dt>Used today</dt><dd className="mono">${(today?.usd ?? 0).toFixed(2)} · {today?.count ?? 0} buys</dd></div>
                  <div><dt>Over a limit</dt><dd>Parked for you to approve</dd></div>
                </dl>
              ) : (
                <p className="empty">{shop?.gateway.error ? `The merchant gateway isn’t answering: ${shop.gateway.error}` : 'Limits appear when the merchant gateway answers.'}</p>
              )}
            </section>
          </div>

          <div className="wallet-col">
            <section className="card" aria-label="Activity">
              <div className="card-head"><h2>Activity</h2><span className="fine">codes masked</span></div>
              {activity.length === 0 ? (
                <p className="empty">No payments yet. Each one shows here with the shielded transaction that paid for it.</p>
              ) : (
                <ul className="activity">
                  {activity.map((a) => (
                    <li key={a.key}>
                      <span className={`act-icon act-${a.kind}`} aria-hidden="true">
                        {a.kind === 'buy' ? (
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 8Z" /><path d="M9 8V6.5a3 3 0 0 1 6 0V8" /></svg>
                        ) : (
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 7 3 12l5 5" /><path d="m16 7 5 5-5 5" /></svg>
                        )}
                      </span>
                      <div className="act-main">
                        <div className="act-title">{a.title}</div>
                        <div className="act-sub">
                          <span className={`status s-${statusTone(a.status)}`}>{a.status.replace('_', ' ')}</span>
                          <span>{a.sub}</span>
                        </div>
                      </div>
                      <div className="act-side">
                        <div className="mono act-amt">{a.amount}</div>
                        {a.txid && /^[0-9a-f]{64}$/.test(a.txid) ? (
                          <a className="fine link-quiet" href={explorer(a.txid)} target="_blank" rel="noreferrer">{when(a.at)} · tx ↗</a>
                        ) : (
                          <span className="fine">{when(a.at)}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card" aria-label="Built on this wallet">
              <div className="card-head"><h2>Spends from this wallet</h2><span className="fine">example code</span></div>
              <ul className="apps">
                <li>
                  <a href="#/examples">
                    <span className="app-name">Shopping agent</span>
                    <span className="fine mono">examples/shopping-agent</span>
                  </a>
                  <span className="chip">LLM</span>
                </li>
                <li>
                  <a href="https://github.com/nickthelegend/oboro/tree/main/examples/paid-api-agent" target="_blank" rel="noreferrer">
                    <span className="app-name">Paid-API agent</span>
                    <span className="fine mono">examples/paid-api-agent</span>
                  </a>
                  <span className="chip">script</span>
                </li>
                <li>
                  <a href="https://github.com/nickthelegend/oboro/tree/main/examples/mcp-client" target="_blank" rel="noreferrer">
                    <span className="app-name">Any MCP client</span>
                    <span className="fine mono">@oboro/mcp</span>
                  </a>
                  <span className="chip">MCP</span>
                </li>
              </ul>
            </section>

            <details className="card who-card">
              <summary><h2>Who saw what</h2><span className="fine">per purchase</span></summary>
              <ul className="who-list">
                {PARTIES.map((p) => (
                  <li key={p.who} className={p.tone === 'warn' ? 'warn' : ''}>
                    <b>{p.who}</b>
                    <span>Saw: {p.saw}</span>
                    <span className="moon">Never: {p.never}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </div>
      </main>
    </div>
  );
}

function ApprovalRow({ run }: { run: ShopRun }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function approve() {
    setBusy(true);
    try {
      const r = await fetch('/api/operator/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: run.id }) });
      const b = await r.json().catch(() => ({}));
      setMsg(r.ok ? 'Approved. The merchant is placing the order.' : b.error ?? `Refused (${r.status})`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="approval">
      <div className="approval-main">
        <div className="approval-title">
          {run.product ? `${run.product.name} · ₹${run.product.value}` : 'Purchase'}
          {run.product && <span className="mono"> · ${run.product.usd.toFixed(2)}</span>}
        </div>
        <p className="fine">Over the $1.00 limit. Asked for by the shopping agent; nothing is bought until you approve, and the agent has no way to approve it.</p>
      </div>
      <button className="btn btn-moon" disabled={busy || !!msg} onClick={approve}>{busy ? 'Approving…' : msg ? 'Approved' : 'Approve'}</button>
      {msg && <p className="fine approval-msg">{msg}</p>}
    </div>
  );
}

// What each party learns. Honest, including the trade-offs we haven't closed.
const PARTIES: { who: string; saw: string; never: string; tone: 'ok' | 'warn' }[] = [
  { who: 'Bitrefill', saw: 'the merchant’s account, the product, its price', never: 'who asked, their wallet or IP', tone: 'ok' },
  { who: 'Merchant gateway', saw: 'the order and amount, via a viewing key', never: 'the payer’s IP, Nym address or wallet', tone: 'ok' },
  { who: 'Zcash chain', saw: 'that a shielded transaction exists', never: 'sender, receiver, amount, memo', tone: 'ok' },
  { who: 'Nym mix nodes', saw: 'one hop each', never: 'both ends of the route', tone: 'ok' },
  { who: 'AI model (example agent only)', saw: 'the chat, product names and prices', never: 'keys, codes, wallet, your IP', tone: 'warn' },
  { who: 'Light-wallet server', saw: 'the wallet’s IP and sync timing', never: 'which payment, or to whom', tone: 'warn' },
];

function SetupCard({ missing }: { missing: string[] }) {
  const [apiKey, setApiKey] = useState('');
  const [phone, setPhone] = useState('');
  const [liveBuy, setLiveBuy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const needKey = missing.includes('BITREFILL_API_KEY');
  const needPhone = missing.includes('OBORO_SHOP_PHONE');
  const needLive = missing.some((m) => m.startsWith('OBORO_BITREFILL_LIVE_BUY'));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const r = await saveShopSetup({ apiKey: apiKey || undefined, phone: phone || undefined, liveBuy: liveBuy || undefined });
      setApiKey('');
      setMsg({ ok: true, text: `Saved ${r.saved.length} setting${r.saved.length === 1 ? '' : 's'} to .env${r.restartedGateway ? '; the gateway is restarting (about 20 s)' : ''}.` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card setup" onSubmit={save} aria-label="Merchant setup">
      <div className="card-head"><h2>Setup required</h2><span className="fine">{missing.map((x) => SETUP_LABEL[x] ?? x).join(' · ')}</span></div>
      <p className="fine">Values go straight into this machine’s gitignored <code>.env</code> (mode 600) and are never shown again. Works from this machine only.</p>
      <div className="setup-fields">
        {needKey && (
          <label>
            <span>Bitrefill API key</span>
            <input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="From bitrefill.com/account/developers" />
          </label>
        )}
        {needPhone && (
          <label>
            <span>Phone to top up</span>
            <input type="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98xxxxxxxx" />
          </label>
        )}
        {needLive && (
          <label className="check">
            <input type="checkbox" checked={liveBuy} onChange={(e) => setLiveBuy(e.target.checked)} />
            <span>Allow real purchases from the merchant’s Bitrefill balance, within its limits</span>
          </label>
        )}
        <button className="btn btn-moon" disabled={saving || (!apiKey && !phone && !liveBuy)}>{saving ? 'Saving…' : 'Save to .env'}</button>
        {msg && <p className={`notice ${msg.ok ? '' : 'notice-bad'}`}>{msg.text}</p>}
      </div>
    </form>
  );
}
