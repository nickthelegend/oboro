import { useEffect, useMemo, useState } from 'react';
import { GiftCard } from './GiftCard';
import { Shell } from './shell';
import { ago, explorerTx, inr, shortTx, startBuy, usd, useRelay, useRun, zecOf, type RelayRun } from './relay';

const STAGES: { key: RelayRun['stage']; label: string; hint: string }[] = [
  { key: 'quote', label: 'Live quote', hint: 'Bitrefill price at the live ZEC rate' },
  { key: 'paying', label: 'Shielded payment', hint: 'x402 challenge answered over Nym' },
  { key: 'verifying', label: 'Verified by viewing key', hint: 'one confirmation on Zcash testnet' },
  { key: 'buying', label: 'Bitrefill order', hint: 'paid from the relay’s balance' },
  { key: 'delivered', label: 'Code delivered, sealed', hint: 'opened only by the buying agent' },
];
const ORDER: RelayRun['stage'][] = ['quote', 'paying', 'paid', 'verifying', 'buying', 'delivered'];

export function Store() {
  const { state, status } = useRelay(10000);
  const [sel, setSel] = useState<{ id: string; value: string } | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [startErr, setStartErr] = useState('');
  const run = useRun(runId);

  useEffect(() => {
    if (sel || !state.products.length) return;
    const p = state.products.find((x) => x.packages.some((k) => k.available)) ?? state.products[0];
    const k = p.packages.find((x) => x.available) ?? p.packages[0];
    if (k) setSel({ id: p.product_id, value: k.value });
  }, [state.products, sel]);

  const product = state.products.find((p) => p.product_id === sel?.id);
  const pkg = product?.packages.find((k) => k.value === sel?.value);
  const busy = !!run && run.stage !== 'delivered' && run.stage !== 'failed';
  const sold = state.limits?.sold_today_usd ?? 0;

  const buy = async () => {
    if (!product || !pkg) return;
    setStartErr('');
    try { setRunId(await startBuy(product.product_id, pkg.value)); }
    catch (e) { setStartErr(e instanceof Error ? e.message : 'Could not start the purchase'); }
  };

  return (
    <Shell active="store" status={status} state={state}>
      <main className="wrap">
        <header className="store-head">
          <div>
            <span className="r-label">Store</span>
            <h1>Gift cards, priced in ZEC.</h1>
            <p>Every price below is Bitrefill’s live price at the live ZEC/USD rate. An agent pays it with one x402 call over Nym.</p>
          </div>
          <div className="stats">
            <div className="stat">
              <div className="k">ZEC / USD</div>
              <div className="v mono">{state.rate ? state.rate.usd.toFixed(2) : '—'}<small>{state.rate ? `${state.rate.source} · ${ago(state.rate.at)}` : ''}</small></div>
            </div>
            <div className="stat">
              <div className="k">Relay balance (Bitrefill)</div>
              <div className="v mono">{typeof state.float_usd === 'number' ? usd(state.float_usd) : '—'}</div>
            </div>
            <div className="stat">
              <div className="k">Sold today</div>
              <div className="v mono">{usd(sold)}<small>{state.limits ? `of ${usd(state.limits.max_usd_per_day)}` : ''}</small></div>
              {state.limits ? <div className="meter"><i style={{ width: `${Math.min(100, (sold / state.limits.max_usd_per_day) * 100)}%` }} /></div> : null}
            </div>
          </div>
        </header>

        {status !== 'loading' && !state.products.length ? (
          <div className="setup">
            <b>The relay isn’t reachable from this page</b>
            {state.setup.length ? `Setup required: ${state.setup.join(', ')}` : state.error ?? 'The catalog loads from the relay over the Nym mixnet when it is online.'}
          </div>
        ) : (
          <div className="store">
            <section className="catalog" aria-label="Catalog">
              {state.products.map((p) => (
                <article key={p.product_id} className={`product ${sel?.id === p.product_id ? 'on' : ''}`}>
                  <GiftCard id={p.product_id} name={p.name} value={sel?.id === p.product_id ? sel.value : p.packages[0]?.value ?? ''} currency={p.currency} zats={(sel?.id === p.product_id ? pkg : p.packages[0])?.zats} />
                  <div className="vals" role="radiogroup" aria-label={`${p.name} values`}>
                    {p.packages.map((k) => (
                      <button key={k.value} role="radio" aria-checked={sel?.id === p.product_id && sel.value === k.value} disabled={!k.available || busy} title={k.reason}
                        className={`val ${sel?.id === p.product_id && sel.value === k.value ? 'on' : ''}`} onClick={() => setSel({ id: p.product_id, value: k.value })}>
                        <b>{inr(k.value, p.currency)}</b>
                        <span className="mono">{k.available ? `${zecOf(k.zats)} ZEC · ${usd(k.usd)}` : (k.reason ?? 'unavailable').replaceAll('_', ' ')}</span>
                      </button>
                    ))}
                  </div>
                </article>
              ))}
              {status === 'loading' ? <div className="product"><span className="r-label">Loading the live catalog…</span></div> : null}
            </section>

            <aside className="checkout" aria-label="Checkout">
              <h2>{run?.quote ? `${run.quote.name} · ${inr(run.quote.value, run.quote.currency)}` : product && pkg ? `${product.name} · ${inr(pkg.value, product.currency)}` : 'Pick a card'}</h2>
              <Quote run={run} pkg={pkg} rate={state.rate?.usd} />
              <button className="r-btn primary" disabled={!pkg || !pkg.available || busy} onClick={buy}>
                {busy ? 'Buying over Nym…' : run?.stage === 'delivered' ? 'Buy another' : 'Buy as the demo agent'}
              </button>
              <p className="r-note">Runs the operator’s demo agent on this machine: a real shielded payment and a real Bitrefill order.</p>
              {startErr ? <div className="err">{startErr}</div> : null}
              {run ? <Stages run={run} /> : null}
              {run?.stage === 'delivered' && run.result ? (
                <div className="sealed">
                  <b>Delivered.</b> Code opened locally by the agent{run.result.code_masked ? <>: <span className="mono">{Object.values(run.result.code_masked).join(' · ')}</span></> : null}.
                  <div className="r-note mono">Bitrefill invoice {run.result.invoice_id} · order {run.result.order_id}</div>
                </div>
              ) : null}
              {run?.stage === 'failed' ? <div className="err">{run.error ?? 'The purchase failed.'}</div> : null}
            </aside>
          </div>
        )}

        <Sales sales={state.sales} />
      </main>
    </Shell>
  );
}

function Quote({ run, pkg, rate }: { run: RelayRun | null; pkg?: { usd: number; zats: number }; rate?: number }) {
  const q = run?.quote;
  const usdPrice = q?.usd ?? pkg?.usd;
  const zats = q?.zats ?? pkg?.zats;
  const zecUsd = q?.zec_usd ?? rate;
  if (usdPrice === undefined || zats === undefined) return null;
  return (
    <div className="rows">
      <div className="row"><span className="k">Bitrefill price</span><span className="v mono">{usd(usdPrice)}</span></div>
      <div className="row"><span className="k">ZEC / USD</span><span className="v mono">{zecUsd?.toFixed(2)}</span></div>
      <div className="row"><span className="k">Markup</span><span className="v mono">none</span></div>
      <div className="row total"><span className="k">Agent pays</span><span className="v mono">{zecOf(zats)} ZEC</span></div>
    </div>
  );
}

function Stages({ run }: { run: RelayRun }) {
  const at = ORDER.indexOf(run.stage === 'paid' ? 'verifying' : run.stage);
  const failedAt = run.stage === 'failed' ? Math.max(0, ...run.events.map((e) => ORDER.indexOf(e.type as RelayRun['stage']))) : -1;
  const time = (key: string) => run.events.find((e) => e.type === key)?.at;
  return (
    <ol className="stages">
      {STAGES.map((s) => {
        const i = ORDER.indexOf(s.key);
        const state = run.stage === 'failed' ? (i < failedAt ? 'done' : i === failedAt ? 'fail' : '') : i < at || run.stage === 'delivered' ? 'done' : i === at ? 'now' : '';
        const t = time(s.key);
        return (
          <li key={s.key} className={`stage ${state}`}>
            <span className="b" aria-hidden="true">{state === 'done' ? '✓' : state === 'fail' ? '×' : null}</span>
            <span>
              {s.label}
              <small>
                {s.key === 'paying' && run.txid ? <a className="mono" href={explorerTx(run.txid)} target="_blank" rel="noreferrer">{shortTx(run.txid)}</a> : s.hint}
              </small>
            </span>
            <span className="t mono">{t ? new Date(t).toLocaleTimeString('en-GB') : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Sales({ sales }: { sales: ReturnType<typeof useRelay>['state']['sales'] }) {
  const rows = useMemo(() => sales.slice(0, 12), [sales]);
  return (
    <section className="sales" aria-label="Recent sales">
      <div className="sales-head">
        <h3>Recent sales</h3>
        <span className="r-note mono" style={{ margin: 0 }}>public · GET /oboro/relay</span>
      </div>
      <div className="sale h"><span>Card</span><span>Price</span><span className="hide-s">Paid</span><span className="hide-s">Shielded tx</span><span>Status</span></div>
      {rows.length === 0 ? <div className="empty">No sales yet. Each sale appears here with only what the relay stores: product, price, txid and time.</div> : rows.map((s) => (
        <div className="sale" key={`${s.txid}-${s.created_at}`}>
          <span>{s.name ?? s.product_id} · {inr(s.value, s.currency)}<br /><span className="muted mono" style={{ fontSize: 12 }}>{ago(s.created_at)}</span></span>
          <span className="mono hide-s">{usd(s.usd)}</span>
          <span className="mono hide-s">{zecOf(s.zats)} ZEC</span>
          <span className="mono hide-s">{s.txid.includes('…') ? s.txid : <a className="tx" href={explorerTx(s.txid)} target="_blank" rel="noreferrer">{shortTx(s.txid)}</a>}</span>
          <span className={`badge ${s.status === 'delivered' ? 'ok' : s.status === 'failed' || s.status === 'refunded' ? 'bad' : 'warn'}`}>{s.status}</span>
        </div>
      ))}
    </section>
  );
}
