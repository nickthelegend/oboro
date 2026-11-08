import { useEffect, useMemo, useState } from 'react';
import { GiftCard, RechargeFace } from './GiftCard';
import { Shell } from './shell';
import {
  ago, explorerTx, fetchCode, inr, kindOf, maskTail, operator, plan, priceLabel, shortTx, stamp, startBuy, usd, useRelay, useRun,
  validIndianMobile, zecOf, type RelayKind, type RelayProduct, type RelayRun,
} from './relay';

type Stage = { key: RelayRun['stage']; label: string; hint: string };
const STAGES = (kind: RelayKind): Stage[] => [
  { key: 'quote', label: 'Live quote', hint: 'Bitrefill price at the live ZEC rate' },
  { key: 'paying', label: 'Shielded payment', hint: 'x402 challenge answered over Nym' },
  { key: 'verifying', label: 'Verified by viewing key', hint: 'one confirmation on Zcash testnet' },
  { key: 'buying', label: kind === 'recharge' ? 'Bitrefill recharge' : 'Bitrefill order', hint: 'paid from the relay’s balance' },
  kind === 'recharge'
    ? { key: 'delivered', label: 'Number recharged', hint: 'the operator confirms by SMS' }
    : { key: 'delivered', label: 'Code delivered to the agent', hint: 'sealed to the agent’s one-time key' },
];
const ORDER: RelayRun['stage'][] = ['quote', 'paying', 'paid', 'verifying', 'buying', 'delivered'];

export function Store() {
  const { state, status } = useRelay(10000);
  const [tab, setTab] = useState<RelayKind>(() => (location.hash.includes('recharge') ? 'recharge' : 'card'));
  const [sel, setSel] = useState<{ id: string; value: string } | null>(null);
  const [phone, setPhone] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [startErr, setStartErr] = useState('');
  const run = useRun(runId);

  const byKind = useMemo(() => ({
    card: state.products.filter((p) => kindOf(p) === 'card'),
    recharge: state.products.filter((p) => kindOf(p) === 'recharge'),
  }), [state.products]);
  const shown = byKind[tab];

  useEffect(() => {
    if (!shown.length || (sel && shown.some((p) => p.product_id === sel.id))) return;
    const p = shown.find((x) => x.packages.some((k) => k.available)) ?? shown[0];
    const k = p.packages.find((x) => x.available) ?? p.packages[0];
    if (k) setSel({ id: p.product_id, value: k.value });
  }, [shown, sel]);

  const product = state.products.find((p) => p.product_id === sel?.id);
  const pkg = product?.packages.find((k) => k.value === sel?.value);
  const kind = kindOf(product);
  const busy = !!run && run.stage !== 'delivered' && run.stage !== 'failed';
  const sold = state.limits?.sold_today_usd ?? 0;
  const snapshot = status === 'snapshot';
  const phoneOk = validIndianMobile(phone);
  const needPhone = kind === 'recharge' && !phoneOk;

  const switchTab = (k: RelayKind) => { if (busy) return; setTab(k); setSel(null); setRunId(null); setStartErr(''); };
  const buy = async () => {
    if (!product || !pkg || needPhone) return;
    setStartErr('');
    try { setRunId(await startBuy(product.product_id, pkg.value, kind === 'recharge' ? `+91${phone}` : undefined)); }
    catch (e) { setStartErr(e instanceof Error ? e.message : 'Could not start the purchase'); }
  };

  const title = run?.quote
    ? titleOf(run.quote.name, run.quote.value, run.quote.currency, run.quote.amount, kindOf(run.quote))
    : product && pkg ? titleOf(product.name, pkg.value, product.currency, pkg.amount, kind) : tab === 'recharge' ? 'Pick a plan' : 'Pick a card';

  return (
    <Shell active="store" status={status} state={state}>
      <main className="wrap">
        <header className="store-head">
          <div>
            <span className="r-label">Store</span>
            <h1>Gift cards and recharges, <span className="moon">priced in ZEC.</span></h1>
            <p>Every price is Bitrefill’s live price at the live ZEC/USD rate, with no markup. An agent pays it with one x402 call over Nym.</p>
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

        <div className="kinds" role="tablist" aria-label="What to buy">
          {([['card', 'Gift cards'], ['recharge', 'Mobile recharge']] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} disabled={busy && tab !== k} onClick={() => switchTab(k)}>
              {label}<span className="n mono">{byKind[k].reduce((n, p) => n + p.packages.length, 0) || ''}</span>
            </button>
          ))}
        </div>

        {status !== 'loading' && !state.products.length ? (
          <div className="setup">
            <b>The relay isn’t reachable from this page</b>
            {state.setup.length ? `Setup required: ${state.setup.join(', ')}` : state.error ?? 'The catalog loads from the relay over the Nym mixnet when it is online.'}
          </div>
        ) : (
          <div className="store">
            <section className={`catalog ${tab === 'recharge' ? 'one' : ''}`} aria-label={tab === 'recharge' ? 'Recharge plans' : 'Gift cards'}>
              {status === 'loading' ? <div className="product"><span className="r-label">Loading the live catalog…</span></div> : null}
              {status !== 'loading' && !shown.length ? (
                <div className="product empty-kind">
                  <b>{tab === 'recharge' ? 'No recharge plans in this catalog yet' : 'No gift cards in this catalog yet'}</b>
                  <span>{snapshot ? `The snapshot from ${stamp(state.captured_at)} predates them. The live relay lists them.` : 'The relay operator sets the catalog (OBORO_RELAY_CATALOG).'}</span>
                </div>
              ) : null}
              {tab === 'card'
                ? shown.map((p) => <CardProduct key={p.product_id} p={p} sel={sel} busy={busy} onPick={setSel} />)
                : shown.map((p) => <PlanList key={p.product_id} p={p} sel={sel} busy={busy} onPick={setSel} />)}
            </section>

            <aside className="checkout" aria-label="Checkout">
              <h2>{title}</h2>
              {kind === 'recharge' && !run ? <PhoneField value={phone} onChange={setPhone} disabled={busy} /> : null}
              {kind === 'recharge' && run ? <div className="to mono">To {maskTail(phone)}</div> : null}
              <Quote run={run} pkg={pkg} rate={state.rate?.usd} />
              <button className="r-btn primary" disabled={snapshot || !pkg || !pkg.available || busy || (!run && needPhone)} onClick={run?.stage === 'delivered' || run?.stage === 'failed' ? () => setRunId(null) : buy}>
                {busy ? 'Buying over Nym…' : run?.stage === 'delivered' || run?.stage === 'failed' ? (kind === 'recharge' ? 'New recharge' : 'Buy another') : kind === 'recharge' ? 'Recharge as the demo agent' : 'Buy as the demo agent'}
              </button>
              <p className="r-note">
                {snapshot
                  ? `This hosted copy can’t reach the relay over Nym, so it shows the relay’s public data captured ${stamp(state.captured_at)}. Live buying runs on the operator’s machine (see the film).`
                  : kind === 'recharge'
                    ? 'A recharge needs the number, so it goes to the relay over Nym and on to Bitrefill. The relay keeps only the last 2 digits.'
                    : 'Runs the operator’s demo agent on this machine: a real shielded payment and a real Bitrefill order.'}
              </p>
              {startErr ? <div className="err">{startErr}</div> : null}
              {run ? <Stages run={run} kind={run.quote ? kindOf(run.quote) : kind} /> : null}
              {run?.stage === 'delivered' && run.result && runId ? (
                (run.quote ? kindOf(run.quote) : kind) === 'recharge'
                  ? <Recharged run={run} phone={phone} />
                  : <CodeTicket runId={runId} run={run} />
              ) : null}
              {run?.stage === 'failed' ? <div className="err">{run.error ?? 'The purchase failed.'}</div> : null}
            </aside>
          </div>
        )}

        <Sales sales={state.sales} note={state.recharge_note} />
      </main>
    </Shell>
  );
}

const titleOf = (name: string, value: string, currency: string, amount: number | undefined, kind: RelayKind) =>
  kind === 'recharge' ? `${operator(name)} · ${priceLabel({ value, amount }, currency)} plan` : `${name.replace(/ India$/, '')} · ${inr(value, currency)}`;

type Pick = { id: string; value: string } | null;
function CardProduct({ p, sel, busy, onPick }: { p: RelayProduct; sel: Pick; busy: boolean; onPick: (s: Pick) => void }) {
  const on = sel?.id === p.product_id;
  const pkg = (on ? p.packages.find((k) => k.value === sel?.value) : undefined) ?? p.packages[0];
  return (
    <article className={`product ${on ? 'on' : ''}`}>
      <GiftCard id={p.product_id} name={p.name} value={pkg?.value ?? ''} currency={p.currency} zats={pkg?.zats} />
      <div className="vals" role="radiogroup" aria-label={`${p.name} values`}>
        {p.packages.map((k) => (
          <button key={k.value} role="radio" aria-checked={on && sel?.value === k.value} disabled={!k.available || busy} title={k.reason}
            className={`val ${on && sel?.value === k.value ? 'on' : ''}`} onClick={() => onPick({ id: p.product_id, value: k.value })}>
            <b>{inr(k.value, p.currency)}</b>
            <span className="mono">{k.available ? `${zecOf(k.zats)} ZEC` : (k.reason ?? 'unavailable').replaceAll('_', ' ')}</span>
          </button>
        ))}
      </div>
    </article>
  );
}

function PlanList({ p, sel, busy, onPick }: { p: RelayProduct; sel: Pick; busy: boolean; onPick: (s: Pick) => void }) {
  const on = sel?.id === p.product_id;
  const pkg = on ? p.packages.find((k) => k.value === sel?.value) : undefined;
  return (
    <article className={`product plans ${on ? 'on' : ''}`}>
      <RechargeFace id={p.product_id} name={operator(p.name)} pkg={pkg} currency={p.currency} />
      <div className="plan-rows" role="radiogroup" aria-label={`${operator(p.name)} plans`}>
        {p.packages.map((k) => {
          const pl = plan(k.value); const picked = on && sel?.value === k.value;
          return (
            <button key={k.value} role="radio" aria-checked={picked} disabled={!k.available || busy} title={k.reason}
              className={`plan ${picked ? 'on' : ''}`} onClick={() => onPick({ id: p.product_id, value: k.value })}>
              <span className="pl-dot" aria-hidden="true" />
              <span className="pl-main"><b>{pl.data}</b><small>{pl.days ? `${pl.days} days` : 'plan'}</small></span>
              <span className="pl-inr">{priceLabel(k, p.currency)}</span>
              <span className="pl-zec mono">{k.available ? <>{zecOf(k.zats)} ZEC<small>{usd(k.usd)}</small></> : (k.reason ?? 'unavailable').replaceAll('_', ' ')}</span>
            </button>
          );
        })}
      </div>
    </article>
  );
}

function PhoneField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  const [show, setShow] = useState(false);
  const bad = value.length === 10 && !validIndianMobile(value);
  return (
    <label className={`phone ${bad ? 'bad' : ''}`}>
      <span className="r-label">Number to recharge</span>
      <span className="phone-in">
        <span className="cc mono">+91</span>
        <input className={`mono ${show ? '' : 'masked'}`} inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={10} placeholder="10-digit mobile"
          value={value} disabled={disabled} aria-invalid={bad} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 10))} />
        <button type="button" className="eye" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide number' : 'Show number'} aria-pressed={show}>
          {show ? 'Hide' : 'Show'}
        </button>
      </span>
      <small>{bad ? 'Indian mobile numbers start with 6, 7, 8 or 9.' : 'Hidden on screen. Sent only to Bitrefill; the relay keeps the last 2 digits.'}</small>
    </label>
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

function Stages({ run, kind }: { run: RelayRun; kind: RelayKind }) {
  const at = ORDER.indexOf(run.stage === 'paid' ? 'verifying' : run.stage);
  const failedAt = run.stage === 'failed' ? Math.max(0, ...run.events.map((e) => ORDER.indexOf(e.type as RelayRun['stage']))) : -1;
  const time = (key: string) => run.events.find((e) => e.type === key)?.at;
  return (
    <ol className="stages">
      {STAGES(kind).map((s) => {
        const i = ORDER.indexOf(s.key);
        const st = run.stage === 'failed' ? (i < failedAt ? 'done' : i === failedAt ? 'fail' : '') : i < at || run.stage === 'delivered' ? 'done' : i === at ? 'now' : '';
        const t = time(s.key);
        return (
          <li key={s.key} className={`stage ${st}`}>
            <span className="b" aria-hidden="true">{st === 'done' ? '✓' : st === 'fail' ? '×' : null}</span>
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

// The code the agent opened from the sealed reply. It stays hidden until asked for; the hosted copy never has it.
export function CodeTicket({ runId, run }: { runId: string; run: RelayRun }) {
  const [code, setCode] = useState<Record<string, string> | null>(null);
  const [shown, setShown] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const fields = code ? Object.entries(code).filter(([k, v]) => typeof v === 'string' && v && !/instruction|expir|link|url/i.test(k)) : [];
  const link = code ? Object.entries(code).find(([k, v]) => /link|url/i.test(k) && /^https:\/\//.test(String(v)))?.[1] : undefined;
  const masked = run.result?.code_masked ? Object.entries(run.result.code_masked) : [];
  const reveal = async () => {
    if (shown) { setShown(false); return; }
    setErr('');
    try { setCode(code ?? await fetchCode(runId)); setShown(true); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Code unavailable'); }
  };
  const copy = async () => {
    try { const c = code ?? await fetchCode(runId); setCode(c); await navigator.clipboard.writeText(Object.values(c).find((v) => typeof v === 'string') ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Copy failed'); }
  };
  return (
    <div className="ticket" aria-live="polite">
      <div className="ticket-top">
        <span className="r-label">Your code</span>
        <span className="badge ok">Delivered</span>
      </div>
      <div className="ticket-code">
        {(shown && fields.length ? fields : masked.length ? masked.map(([k]) => [k, ''] as [string, string]) : [['code', '']]).map(([k, v]) => (
          <div key={k} className="tc-row">
            <span className="tc-k">{k.replaceAll('_', ' ')}</span>
            <span className={`tc-v mono ${shown ? 'open' : ''}`} data-code-field={k}>{shown ? v : '•••• •••• ••••'}</span>
          </div>
        ))}
      </div>
      <div className="ticket-act">
        <button className="r-btn ghost sm" onClick={reveal}>{shown ? 'Hide code' : 'Reveal code'}</button>
        <button className="r-btn ghost sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        {shown && link ? <a className="r-btn ghost sm" href={link} target="_blank" rel="noreferrer">Redeem →</a> : null}
      </div>
      {err ? <p className="r-note" style={{ color: 'var(--bad)' }}>{err}</p> : null}
      <p className="r-note mono">Opened by the agent from the sealed reply · Bitrefill invoice {run.result?.invoice_id}</p>
    </div>
  );
}

function Recharged({ run, phone }: { run: RelayRun; phone: string }) {
  const q = run.quote;
  return (
    <div className="ticket rc" aria-live="polite">
      <div className="ticket-top">
        <span className="r-label">Recharge</span>
        <span className="badge ok">Done</span>
      </div>
      <div className="rc-big">
        <b>{q ? plan(q.value).data : 'Plan'}</b>
        <span>{q && plan(q.value).days ? `${plan(q.value).days} days · ` : ''}{q ? priceLabel({ value: q.value, amount: q.amount }, q.currency) : ''}</span>
      </div>
      <div className="row"><span className="k">Number</span><span className="v mono">{phone ? maskTail(phone) : run.result?.phone_masked}</span></div>
      <div className="row"><span className="k">Relay keeps</span><span className="v mono">{run.result?.phone_masked ?? 'last 2 digits'}</span></div>
      <p className="r-note mono">No code to redeem: Bitrefill tops up the number directly · invoice {run.result?.invoice_id}</p>
    </div>
  );
}

function Sales({ sales, note }: { sales: ReturnType<typeof useRelay>['state']['sales']; note?: string }) {
  const rows = useMemo(() => sales.slice(0, 12), [sales]);
  return (
    <section className="sales" aria-label="Recent sales">
      <div className="sales-head">
        <h3>Recent sales</h3>
        <span className="r-note mono" style={{ margin: 0 }}>public · GET /oboro/relay</span>
      </div>
      <div className="sale h"><span>Item</span><span className="hide-s">Price</span><span className="hide-s">Paid</span><span className="hide-s">Shielded tx</span><span>Status</span></div>
      {rows.length === 0 ? <div className="empty">No sales yet. Each sale appears here with only what the relay stores: product, price, txid and time.</div> : rows.map((s) => {
        const rc = kindOf(s) === 'recharge';
        return (
          <div className="sale" key={`${s.txid}-${s.created_at}`}>
            <span>
              {rc ? `${operator(s.name ?? s.product_id ?? '')} · ${plan(s.value).data}${plan(s.value).days ? `, ${plan(s.value).days} d` : ''}` : `${(s.name ?? s.product_id ?? '').replace(/ India$/, '')} · ${inr(s.value, s.currency)}`}
              <br /><span className="muted mono" style={{ fontSize: 12 }}>{ago(s.created_at)}{rc && s.phone_masked ? ` · to ${s.phone_masked}` : ''}</span>
            </span>
            <span className="mono hide-s">{usd(s.usd)}</span>
            <span className="mono hide-s">{zecOf(s.zats)} ZEC</span>
            <span className="mono hide-s">{s.txid.includes('…') ? s.txid : <a className="tx" href={explorerTx(s.txid)} target="_blank" rel="noreferrer">{shortTx(s.txid)}</a>}</span>
            <span className={`badge ${s.status === 'delivered' ? 'ok' : s.status === 'failed' || s.status === 'refunded' ? 'bad' : 'warn'}`}>{s.status}</span>
          </div>
        );
      })}
      {note ? <div className="sales-note">{note}</div> : null}
    </section>
  );
}
