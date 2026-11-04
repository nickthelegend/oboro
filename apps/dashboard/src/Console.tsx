import { useState } from 'react';
import { explorer, short, startRun, zec, type AgentEvent, type ConsoleState, type Run } from './api';
import { Nav } from './chrome';
import { useConsole } from './useConsole';

const VEILS = ['Entry gateway', 'Mix 1', 'Mix 2', 'Mix 3', 'Tsuki’s gateway'];

const EVENT_LABEL: Record<string, string> = {
  request: 'Request sent into the mixnet',
  payment_required: '402 Payment Required',
  policy_ok: 'Spend policy: allowed',
  policy_refused: 'Spend policy: refused',
  paying: 'Paying in shielded ZEC',
  paid: 'Payment broadcast',
  pending: 'Waiting for the block',
  settled: 'Payment verified by Tsuki',
  response: 'Response received',
  error: 'Error',
};

export function Console() {
  const { state, offline } = useConsole(2000);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const runs = state?.runs ?? [];
  const active = runs.find((r) => r.id === selected) ?? runs[0];
  const running = runs.some((r) => r.status === 'running');

  async function buy(endpoint: string) {
    setErr(null);
    setBusy(endpoint);
    try {
      const { id } = await startRun(endpoint);
      setSelected(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page console-page">
      <Nav console />
      <div className="console frame">
        <header className="console-head">
          <div>
            <span className="eyebrow">
              <span className={`dot ${state ? '' : 'dot-off'}`} /> Console · Zcash testnet · Nym mainnet mixnet
            </span>
            <h1 className="console-title">Kumo pays Tsuki, in the dark.</h1>
          </div>
          <NodePills state={state} />
        </header>

        {offline && (
          <div className="banner banner-bad" role="alert">
            <strong>Console server offline.</strong> Start it with <code>pnpm --filter @oboro/dashboard serve</code>.{' '}
            <span className="mono fine">({offline})</span>
          </div>
        )}
        {state && state.setup.length > 0 && (
          <div className="banner banner-warn" role="alert">
            <strong>Setup required:</strong> {state.setup.join(' · ')}
          </div>
        )}
        {err && (
          <div className="banner banner-bad" role="alert">
            {err}
          </div>
        )}

        <div className="console-grid">
          <AgentPanel
            who="kumo"
            name="Kumo"
            role="Buyer agent"
            lines={[
              ['Wallet', state?.buyer.ok ? 'Shielded · local spending key' : (state?.buyer.error ?? '—')],
              ['Balance', state?.buyer.balanceZats !== undefined ? `${zec(state.buyer.balanceZats)} TAZ` : '—'],
              [
                'Spent today',
                state?.buyer.spentTodayZats !== undefined
                  ? `${state.buyer.spentTodayZats.toLocaleString('en-US')} / ${(state.buyer.dailyCapZats ?? 0).toLocaleString('en-US')} zats`
                  : '—',
              ],
            ]}
          >
            <Budget state={state} />
            <div className="buy-list">
              {(state?.catalog ?? []).map((c) => (
                <button
                  key={c.endpoint}
                  className="buy"
                  disabled={!state || running || !!busy || state.setup.length > 0}
                  onClick={() => buy(c.endpoint)}
                >
                  <span className="buy-path mono">{c.path}</span>
                  <span className="buy-desc">{c.description}</span>
                  <span className="buy-price">{c.priceZats.toLocaleString('en-US')} zats</span>
                </button>
              ))}
              {state && state.catalog.length === 0 && <p className="empty">Tsuki is not advertising anything yet.</p>}
            </div>
            <RunList runs={runs} active={active?.id} onPick={setSelected} />
          </AgentPanel>

          <section className="veil-panel" aria-label="Request path through the mixnet">
            <div className="veil-stage">
              <div className="veil-cols" aria-hidden="true">
                <span className="veil-node">Kumo</span>
                {VEILS.map((v, i) => (
                  <span key={v} className="veil-col" style={{ ['--i' as string]: i }}>
                    <em>{v}</em>
                  </span>
                ))}
                <span className="veil-node moon">Tsuki</span>
              </div>
              {active?.status === 'running' && <span className="packet" aria-hidden="true" />}
            </div>
            {active ? <RunDetail run={active} /> : <p className="empty center">No runs yet. Pick something for Kumo to buy.</p>}
          </section>

          <AgentPanel
            who="tsuki"
            name="Tsuki"
            role="Seller agent · no public port"
            lines={[
              ['Nym address', short(state?.gate.nymAddress, 10, 8)],
              ['Pay-to (shielded)', short(state?.seller.payTo, 10, 6)],
              ['Server holds', 'Viewing key only'],
            ]}
          >
            <SellerSaw state={state} />
            <Ledger state={state} />
          </AgentPanel>
        </div>
      </div>
    </div>
  );
}

function NodePills({ state }: { state: ConsoleState | null }) {
  const pill = (label: string, ok?: boolean, extra?: string) => (
    <span className={`node-pill ${ok ? 'ok' : 'off'}`}>
      <span className="dot" /> {label}
      {extra && <span className="mono fine"> {extra}</span>}
    </span>
  );
  return (
    <div className="node-pills">
      {pill('Kumo’s tunnel', state?.tunnel.ok, state?.tunnel.ok ? short(state.tunnel.nymAddress, 6, 4) : 'down')}
      {pill('Tsuki’s gate', state?.gate.ok, state?.gate.ok ? `${state.gate.served ?? 0} served` : 'down')}
    </div>
  );
}

function AgentPanel({
  who,
  name,
  role,
  lines,
  children,
}: {
  who: 'kumo' | 'tsuki';
  name: string;
  role: string;
  lines: [string, string][];
  children: React.ReactNode;
}) {
  return (
    <section className={`agent agent-${who}`} aria-label={name}>
      <div className="agent-head">
        <img src={`/${who}.jpg`} alt="" className="portrait" width={64} height={64} />
        <div>
          <h2>{name}</h2>
          <p className="fine">{role}</p>
        </div>
      </div>
      <dl className="kv">
        {lines.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="mono">{v}</dd>
          </div>
        ))}
      </dl>
      {children}
    </section>
  );
}

function Budget({ state }: { state: ConsoleState | null }) {
  const spent = state?.buyer.spentTodayZats ?? 0;
  const cap = state?.buyer.dailyCapZats ?? 0;
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
  return (
    <div className="budget" aria-label="Daily budget">
      <div className="budget-bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="fine">
        Policy: ≤ {(state?.buyer.maxPerRequestZats ?? 0).toLocaleString('en-US')} zats per call · daily cap{' '}
        {cap.toLocaleString('en-US')} zats · checked before any transaction exists
      </p>
    </div>
  );
}

function RunList({ runs, active, onPick }: { runs: Run[]; active?: string; onPick: (id: string) => void }) {
  if (!runs.length) return null;
  return (
    <div className="runs">
      <h3 className="mini">Runs</h3>
      {runs.slice(0, 6).map((r) => (
        <button key={r.id} className={`run ${r.id === active ? 'on' : ''}`} onClick={() => onPick(r.id)}>
          <span className={`status s-${r.status}`}>{r.status}</span>
          <span className="mono">{r.path}</span>
          <span className="fine">{new Date(r.startedAt).toLocaleTimeString()}</span>
        </button>
      ))}
    </div>
  );
}

function RunDetail({ run }: { run: Run }) {
  return (
    <div className="run-detail">
      <div className="run-top">
        <span className={`status s-${run.status}`}>{run.status}</span>
        <span className="mono">GET nym://Tsuki{run.path}</span>
        {run.mixMs !== undefined && <span className="fine mono">mixnet round trip {(run.mixMs / 1000).toFixed(1)} s</span>}
      </div>
      <ol className="timeline">
        {run.events.map((e, i) => (
          <TimelineItem key={i} e={e} />
        ))}
      </ol>
      {run.txid && (
        <a className="tx-card" href={explorer(run.txid)} target="_blank" rel="noreferrer">
          <span className="fine">Shielded payment on Zcash testnet{run.height ? ` · block ${run.height}` : ''}</span>
          <span className="mono">{short(run.txid, 18, 10)} ↗</span>
        </a>
      )}
      {run.response && (
        <pre className="response mono" aria-label="Paid response">
          {run.response}
        </pre>
      )}
      {run.error && <p className="banner banner-bad">{run.error}</p>}
    </div>
  );
}

function TimelineItem({ e }: { e: AgentEvent }) {
  return (
    <li className={`tl tl-${e.type}`}>
      <span className="tl-dot" />
      <div>
        <div className="tl-title">
          {EVENT_LABEL[e.type] ?? e.type}
          {e.zats !== undefined && <span className="mono"> · {e.zats.toLocaleString('en-US')} zats</span>}
          {e.status !== undefined && <span className="mono"> · HTTP {e.status}</span>}
          {e.mixMs !== undefined && <span className="mono"> · {(e.mixMs / 1000).toFixed(1)} s</span>}
        </div>
        {e.detail && <div className="fine">{e.detail}</div>}
        <div className="fine mono">{new Date(e.ts).toLocaleTimeString()}</div>
      </div>
    </li>
  );
}

function SellerSaw({ state }: { state: ConsoleState | null }) {
  const ev = (state?.seller.gateEvents ?? []).filter((e) => e.kind === 'request').slice(-5).reverse();
  return (
    <div className="saw-box">
      <h3 className="mini">What Tsuki could see</h3>
      {ev.length === 0 ? (
        <p className="empty">No requests have reached Tsuki yet.</p>
      ) : (
        <ul className="saw-list">
          {ev.map((e) => (
            <li key={e.seq}>
              <div className="mono">
                {e.method} {e.path}
              </div>
              <div className="saw-facts">
                <span>
                  From IP <b className="moon">none</b>
                </span>
                <span>
                  Sender <b className="moon">reply tag only</b>
                </span>
                <span className="mono fine">stream {short(e.streamId?.replace(/^StreamId\((0x)?|\)$/g, ''), 6, 4)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Ledger({ state }: { state: ConsoleState | null }) {
  const rows = (state?.seller.ledger ?? []).slice(-6).reverse();
  return (
    <div className="ledger">
      <h3 className="mini">Tsuki’s ledger</h3>
      {rows.length === 0 ? (
        <p className="empty">Nothing paid yet.</p>
      ) : (
        <ul>
          {rows.map((r, i) => (
            <li key={i}>
              <span className={`status s-${r.status === 'paid' ? 'paid' : 'running'}`}>{r.status}</span>
              <span className="mono">{r.path}</span>
              <span className="mono">{r.priceZats.toLocaleString('en-US')} zats</span>
              {r.txid ? (
                <a className="mono link" href={explorer(r.txid)} target="_blank" rel="noreferrer">
                  {short(r.txid, 6, 4)} ↗
                </a>
              ) : (
                <span className="fine">—</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
