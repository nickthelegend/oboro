import { useEffect, useRef, useState } from 'react';
import { explorer, getShop, saveShopSetup, short, startShopRun, zec, type ShopRun, type ShopState, type ShopStep } from './api';
import { Nav } from './chrome';
import { useConsole } from './useConsole';

// The errand Kumo runs. Product and value must be on Tsuki's guardrail allow-list; the price always comes from Bitrefill.
const ERRAND = { product_id: 'swiggy-money-india', value: '50', label: 'Buy a ₹50 Swiggy Money card', brand: 'Swiggy Money India', kind: 'food and grocery credit' };

// The loop, left to right. Each station lights up from the run's real steps.
const STATIONS: { key: string; title: string; note: string; done: string[]; live: string[] }[] = [
  { key: 'browse', title: 'Browse', note: 'Bitrefill catalog, over Nym', done: ['browsed'], live: ['browse'] },
  { key: 'quote', title: 'Quote', note: 'USD price from Bitrefill', done: ['quoted'], live: [] },
  { key: 'pay', title: 'Pay', note: 'Shielded ZEC, over Nym', done: ['settled'], live: ['payment_required', 'policy_ok', 'paying', 'paid', 'pending', 'request'] },
  { key: 'buy', title: 'Buy', note: 'Bitrefill invoice, credits', done: ['bitrefill', 'delivered'], live: ['processing'] },
  { key: 'deliver', title: 'Delivered', note: 'Code lands, masked', done: ['delivered'], live: [] },
];

const STEP_LABEL: Record<string, string> = {
  browse: 'Browsing Tsuki’s shop',
  browsed: 'Catalog received',
  quoted: 'Price quoted by Bitrefill',
  request: 'Purchase request sent into the mixnet',
  payment_required: '402 Payment Required',
  policy_ok: 'Kumo’s spend policy: allowed',
  policy_refused: 'Spend policy: refused',
  paying: 'Paying in shielded ZEC',
  paid: 'Payment broadcast',
  pending: 'Waiting for the block',
  settled: 'Payment verified, txid reserved',
  bitrefill: 'Tsuki placed the Bitrefill order',
  processing: 'Bitrefill is processing',
  delivered: 'Delivered',
  needs_approval: 'Needs a human',
  error: 'Error',
};

function useShop(intervalMs = 2000) {
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

function stationState(run: ShopRun | undefined, s: (typeof STATIONS)[number], index: number): 'idle' | 'live' | 'done' | 'bad' {
  if (!run) return 'idle';
  const types = new Set(run.steps.map((x) => x.type));
  if (s.done.some((t) => types.has(t)) && !(s.key === 'buy' && run.status === 'failed' && !types.has('delivered'))) return 'done';
  const reached = STATIONS.slice(0, index).every((p) => p.done.some((t) => types.has(t)));
  if (run.status === 'failed' || run.status === 'refused') return reached ? 'bad' : 'idle';
  if (run.status === 'needs_approval' && s.key === 'buy') return 'bad';
  if (s.live.some((t) => types.has(t)) || (reached && run.status === 'running')) return 'live';
  return 'idle';
}

type Quote = { at: number; mixMs?: number; error?: string; body?: { name: string; in_stock: boolean; packages: { value: string; usd: number; currency: string }[] } };
function useQuote() {
  const [quote, setQuote] = useState<Quote | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/shop/quote').then((r) => r.json()).then((q) => alive && setQuote(q)).catch((e) => alive && setQuote({ at: Date.now(), error: String(e) }));
    return () => { alive = false; };
  }, []);
  return quote;
}

const SETUP_LABEL: Record<string, string> = {
  BITREFILL_API_KEY: 'Bitrefill API key',
  'OBORO_BITREFILL_LIVE_BUY=1': 'live purchases switched on',
  OBORO_SHOP_PHONE: 'a phone to top up',
};

export function Shop() {
  const { state } = useConsole(4000);
  const { shop, offline } = useShop(2000);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runs = shop?.runs ?? [];
  const run = runs.find((r) => r.id === selected) ?? runs[0];
  const running = runs.some((r) => r.status === 'running') || (state?.runs ?? []).some((r) => r.status === 'running');
  const tsukiSetup = shop?.tsuki.setup ?? [];
  const setup = [...tsukiSetup, ...(shop?.consoleSetup ?? [])];
  const g = shop?.tsuki.guardrails;
  const today = shop?.tsuki.today;
  const purchases = (shop?.tsuki.ledger ?? []).slice().reverse();
  const quote = useQuote();

  async function go() {
    setErr(null);
    setBusy(true);
    try {
      const { id } = await startShopRun(ERRAND.product_id, ERRAND.value);
      setSelected(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page console-page">
      <Nav console />
      <div className="console frame shop">
        <header className="console-head">
          <div>
            <span className="eyebrow">
              <span className={`dot ${shop ? '' : 'dot-off'}`} /> Shop · Bitrefill · paid in shielded ZEC over Nym
            </span>
            <h1 className="console-title">Kumo goes shopping.</h1>
            <p className="shop-lede">
              An AI agent with no Bitrefill account, no card and no exposed IP buys a real gift card. Its shielded payment to Tsuki
              authorises one purchase; Tsuki pays Bitrefill from event credits, inside hard caps, once per payment.
            </p>
          </div>
          <div className="node-pills">
            <a className="node-pill ok" href="#/console">
              <span className="dot" /> API console
            </a>
            <span className={`node-pill ${shop && !shop.tsuki.error ? 'ok' : 'off'}`}>
              <span className="dot" /> Tsuki’s shop {shop?.tsuki.error ? 'down' : ''}
            </span>
          </div>
        </header>

        {offline && (
          <div className="banner banner-bad" role="alert">
            <strong>Console server offline.</strong> <span className="mono fine">({offline})</span>
          </div>
        )}
        {err && <div className="banner banner-bad" role="alert">{err}</div>}

        {setup.length > 0 && <SetupCard missing={setup} />}

        <LoopRail run={run} />

        <div className="shop-grid">
          <section className="agent shop-errand" aria-label="The errand">
            <h3 className="mini">The errand</h3>
            <div className="ticket">
              <div className="ticket-top">
                <span className="ticket-brand">{ERRAND.brand}</span>
                <span className="status s-paid">{run?.product ? 'live price' : 'catalog'}</span>
              </div>
              <div className="ticket-amount">
                ₹{ERRAND.value}
                <span className="fine"> {ERRAND.kind}</span>
              </div>
              <dl className="kv">
                <div>
                  <dt>Bitrefill price</dt>
                  <dd className="mono">{run?.product ? `$${run.product.usd.toFixed(2)}` : '$0.55 at last check'}</dd>
                </div>
                <div>
                  <dt>Delivered to</dt>
                  <dd className="mono">Tsuki’s Bitrefill account</dd>
                </div>
                <div>
                  <dt>Kumo pays Tsuki</dt>
                  <dd className="mono">5,000 zats, shielded</dd>
                </div>
                <div>
                  <dt>Kumo’s balance</dt>
                  <dd className="mono">{state?.buyer.balanceZats !== undefined ? `${zec(state.buyer.balanceZats)} TAZ` : '—'}</dd>
                </div>
              </dl>
            </div>
            <button className="btn btn-moon shop-go" disabled={!shop || running || busy || setup.length > 0} onClick={go}>
              {running ? 'Kumo is out shopping…' : ERRAND.label}
            </button>
            {setup.length > 0 && <p className="fine">Unlocks after setup: {setup.map((x) => SETUP_LABEL[x] ?? x).join(' · ')}</p>}

            <h3 className="mini">Guardrails (enforced by Tsuki, in code)</h3>
            {g ? (
              <ul className="rails">
                <li><span>Allowed</span><b className="mono">{g.allow.map((a) => `${a.product_id} ${a.values.join('/')}`).join(', ')}</b></li>
                <li><span>Per purchase</span><b className="mono">≤ ${g.maxUsdPerPurchase.toFixed(2)}</b></li>
                <li><span>Per day</span><b className="mono">≤ ${g.maxUsdPerDay.toFixed(2)} · {g.maxPurchasesPerDay} buys</b></li>
                <li><span>Today</span><b className="mono">${(today?.usd ?? 0).toFixed(2)} · {today?.count ?? 0} buys</b></li>
                <li><span>Above the cap</span><b>Nothing is bought; a human approves with <code>shop:approve</code></b></li>
                <li><span>Replays</span><b>One purchase per Zcash txid, reserved before the invoice</b></li>
              </ul>
            ) : (
              <p className="empty">{shop?.tsuki.error ? `Tsuki is not answering: ${shop.tsuki.error}` : 'Loading Tsuki’s rules…'}</p>
            )}
          </section>

          <section className="veil-panel" aria-label="Run">
            {run ? <ShopRunDetail run={run} /> : <LiveQuote quote={quote} />}
            {runs.length > 1 && (
              <div className="runs">
                <h3 className="mini">Earlier errands</h3>
                {runs.slice(0, 6).map((r) => (
                  <button key={r.id} className={`run ${r.id === run?.id ? 'on' : ''}`} onClick={() => setSelected(r.id)}>
                    <span className={`status s-${statusClass(r.status)}`}>{r.status.replace('_', ' ')}</span>
                    <span className="mono">{r.product ? `${r.product.id} ${r.product.value}` : ERRAND.product_id}</span>
                    <span className="fine">{new Date(r.startedAt).toLocaleTimeString()}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="agent" aria-label="Who saw what">
            <WhoSaw run={run} />
          </section>
        </div>

        <section className="agent receipts" aria-label="Receipts">
          <h3 className="mini">Tsuki’s purchase ledger (masked)</h3>
          {purchases.length === 0 ? (
            <p className="empty">No purchases yet. The first one appears here with its Bitrefill invoice ID and the Zcash txid that authorised it.</p>
          ) : (
            <div className="receipt-table" role="table">
              <div className="receipt-row head" role="row">
                <span>Status</span><span>Product</span><span>USD</span><span>Bitrefill invoice</span><span>Authorised by</span><span>When</span>
              </div>
              {purchases.map((p) => (
                <div className="receipt-row" role="row" key={p.txid + p.created_at}>
                  <span><span className={`status s-${statusClass(p.status)}`}>{p.status.replace('_', ' ')}</span></span>
                  <span className="mono">{p.product_id} {p.value}{p.phone_masked ? ` → ${p.phone_masked}` : ''}</span>
                  <span className="mono">${p.usd.toFixed(2)}</span>
                  <span className="mono">{p.invoice_id ? short(p.invoice_id, 10, 4) : '—'}</span>
                  <span className="mono">{p.txid}</span>
                  <span className="fine">{new Date(p.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const statusClass = (s: string) => (s === 'delivered' ? 'paid' : s === 'running' || s === 'processing' || s === 'reserved' ? 'running' : s === 'needs_approval' ? 'warn' : 'failed');

function LiveQuote({ quote }: { quote: Quote | null }) {
  if (!quote) return (
    <div className="quote">
      <h3 className="mini">Tsuki’s catalog · asking through the mixnet…</h3>
      <p className="empty">Fetching Swiggy Money India from Bitrefill via Nym. This takes a few seconds.</p>
    </div>
  );
  if (quote.error || !quote.body) return (
    <div className="quote">
      <h3 className="mini">Tsuki’s catalog</h3>
      <p className="banner banner-bad">Could not read the catalog: {quote.error}</p>
    </div>
  );
  const pk = [...quote.body.packages].sort((a, b) => Number(a.value) - Number(b.value));
  return (
    <div className="quote">
      <h3 className="mini">Tsuki’s catalog · live from Bitrefill{quote.mixMs ? ` · ${(quote.mixMs / 1000).toFixed(1)} s through Nym` : ''}</h3>
      <p className="quote-name">{quote.body.name} <span className={`status s-${quote.body.in_stock ? 'paid' : 'failed'}`}>{quote.body.in_stock ? 'in stock' : 'out of stock'}</span></p>
      <ul className="quote-list">
        {pk.map((p) => (
          <li key={p.value} className={p.value === ERRAND.value ? 'on' : ''}>
            <span className="mono">₹{Number(p.value).toLocaleString('en-IN')}</span>
            <span className="mono">${p.usd.toFixed(2)}</span>
            <span className="fine">{p.value === ERRAND.value ? 'allowed by the guardrails' : 'above the cap: needs a human'}</span>
          </li>
        ))}
      </ul>
      <p className="fine">No errands yet. Press the button and Kumo browses, pays and buys on its own.</p>
    </div>
  );
}

function LoopRail({ run }: { run?: ShopRun }) {
  return (
    <ol className="loop-rail" aria-label="Purchase loop">
      {STATIONS.map((s, i) => {
        const st = stationState(run, s, i);
        return (
          <li key={s.key} className={`station st-${st}`}>
            <span className="station-num mono">{String(i + 1).padStart(2, '0')}</span>
            <span className="station-title">{s.title}</span>
            <span className="fine">{s.note}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ShopRunDetail({ run }: { run: ShopRun }) {
  const delivered = run.status === 'delivered';
  return (
    <div className="run-detail">
      <div className="run-top">
        <span className={`status s-${statusClass(run.status)}`}>{run.status.replace('_', ' ')}</span>
        <span className="mono">{run.product ? `${run.product.name} · ${run.product.value} ${run.product.currency}` : `${ERRAND.product_id} · ${ERRAND.value} INR`}</span>
      </div>
      {delivered && (
        <div className="delivered-card">
          <span className="eyebrow">Delivered by Bitrefill</span>
          <div className="delivered-amount">₹{run.product?.value} {run.product?.name ?? ''}{run.phoneMasked ? ` → ${run.phoneMasked}` : ''}</div>
          <dl className="kv">
            <div><dt>Invoice ID</dt><dd className="mono">{run.invoiceId}</dd></div>
            <div><dt>Order ID</dt><dd className="mono">{run.orderId}</dd></div>
            {run.redemptionMasked && Object.entries(run.redemptionMasked).map(([k, v]) => (
              <div key={k}><dt>{k} (masked)</dt><dd className="mono">{v}</dd></div>
            ))}
          </dl>
        </div>
      )}
      <ol className="timeline">
        {run.steps.map((e, i) => <StepItem key={i} e={e} />)}
      </ol>
      {run.txid && (
        <a className="tx-card" href={explorer(run.txid)} target="_blank" rel="noreferrer">
          <span className="fine">Shielded authorisation payment on Zcash testnet</span>
          <span className="mono">{short(run.txid, 18, 10)} ↗</span>
        </a>
      )}
      {run.error && <p className="banner banner-bad">{run.error}</p>}
    </div>
  );
}

function StepItem({ e }: { e: ShopStep }) {
  const tone = e.type === 'delivered' || e.type === 'settled' || e.type === 'paid' || e.type === 'quoted' ? 'tl-paid' : e.type === 'error' || e.type === 'policy_refused' ? 'tl-error' : '';
  return (
    <li className={`tl ${tone}`}>
      <span className="tl-dot" />
      <div>
        <div className="tl-title">
          {STEP_LABEL[e.type] ?? e.type}
          {e.zats !== undefined && <span className="mono"> · {e.zats.toLocaleString('en-US')} zats</span>}
          {e.usd !== undefined && <span className="mono"> · ${e.usd.toFixed(2)}</span>}
          {e.status !== undefined && <span className="mono"> · HTTP {e.status}</span>}
          {e.mixMs !== undefined && <span className="mono"> · {(e.mixMs / 1000).toFixed(1)} s</span>}
        </div>
        {e.detail && <div className="fine">{e.detail}</div>}
        <div className="fine mono">{new Date(e.ts).toLocaleTimeString()}</div>
      </div>
    </li>
  );
}

// What each party learns in this setup. Honest, including the one leak we haven't closed (light-wallet sync).
const PARTIES: { who: string; saw: string; never: string; tone: 'ok' | 'warn' }[] = [
  { who: 'Bitrefill', saw: 'Tsuki’s account, the product, its $0.55 price', never: 'Kumo, Kumo’s wallet, Kumo’s IP', tone: 'ok' },
  { who: 'Tsuki (seller)', saw: 'The order and the amount, via its viewing key', never: 'Kumo’s IP, Nym address or payer address', tone: 'ok' },
  { who: 'Zcash chain', saw: 'A shielded v6 transaction exists', never: 'Sender, receiver, amount, memo', tone: 'ok' },
  { who: 'Nym mix nodes', saw: 'One hop each: previous and next hop', never: 'Both ends of the route at once', tone: 'ok' },
  { who: 'Light-wallet server', saw: 'The wallets’ IP and sync timing', never: 'Which payment, or to whom', tone: 'warn' },
];

function WhoSaw({ run }: { run?: ShopRun }) {
  return (
    <div className="who-saw">
      <h3 className="mini">Who saw what{run?.status === 'delivered' ? ' · this purchase' : ''}</h3>
      <ul>
        {PARTIES.map((p) => (
          <li key={p.who} className={`who who-${p.tone}`}>
            <div className="who-name">{p.who}</div>
            <div className="who-row"><span className="fine">Saw</span><span>{p.saw}</span></div>
            <div className="who-row"><span className="fine">Never saw</span><span className="moon">{p.never}</span></div>
          </li>
        ))}
      </ul>
      <p className="fine">The last row is the open leak: compact-block sync talks to the light-wallet server directly. Nym’s 2-hop dVPN closes it.</p>
    </div>
  );
}

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
      setMsg({ ok: true, text: `Saved ${r.saved.length} setting${r.saved.length === 1 ? '' : 's'} to .env${r.restartedTsuki ? '; Tsuki is restarting (about 20 s)' : ''}.` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="agent setup-card" onSubmit={save} aria-label="Shop setup">
      <div>
        <span className="eyebrow"><span className="dot dot-warn" /> Setup required</span>
        <h2>Connect Tsuki to Bitrefill</h2>
        <p className="fine">
          Values go straight into this machine’s gitignored <code>.env</code> (mode 600). They are never shown again, logged or
          sent anywhere but Bitrefill. This form only works from this machine.
        </p>
      </div>
      <div className="setup-fields">
        {needKey && (
          <label>
            <span>Bitrefill API key</span>
            <input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="From bitrefill.com/account/developers" />
          </label>
        )}
        {needPhone && (
          <label>
            <span>Phone to top up (a team phone)</span>
            <input type="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98xxxxxxxx" />
          </label>
        )}
        {needLive && (
          <label className="check">
            <input type="checkbox" checked={liveBuy} onChange={(e) => setLiveBuy(e.target.checked)} />
            <span>Allow real purchases from Tsuki’s Bitrefill balance, within the caps above</span>
          </label>
        )}
        <button className="btn btn-moon" disabled={saving || (!apiKey && !phone && !liveBuy)}>{saving ? 'Saving…' : 'Save to .env'}</button>
        {msg && <p className={`banner ${msg.ok ? 'banner-warn' : 'banner-bad'}`}>{msg.text}</p>}
      </div>
    </form>
  );
}
