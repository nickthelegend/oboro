import { useEffect, useRef, useState } from 'react';
import { chatAgent, type ChatTurn, type ToolTrace } from './api';
import { Logo } from './chrome';
import { Shell } from './shell';
import { useConsole } from './useConsole';
import { explorerTx, inr, kindOf, plan, shortTx, useRelay, useRun } from './relay';
import { CodeTicket } from './Store';

const SOURCE = 'https://github.com/nickthelegend/oboro/blob/main/examples/shopping-agent/agent.ts';
const TOOL: Record<string, string> = {
  catalog: 'cards.catalog()', quote: 'cards.quote()', buy: 'cards.buy()', receipt: 'cards.receipt()',
};
const SUGGEST = [
  'What gift cards can you get me?',
  'Get me a ₹250 Blinkit card',
  'Recharge my Jio number for a month',
];

// The conversation survives route changes for this page load only.
const memory: { turns: ChatTurn[]; sessionId: string } = { turns: [], sessionId: '' };

export function Agent() {
  const { state, status } = useRelay();
  const con = useConsole(5000);
  const [turns, setTurnsRaw] = useState<ChatTurn[]>(memory.turns);
  const [sessionId, setSessionRaw] = useState(memory.sessionId);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const setTurns = (t: ChatTurn[]) => setTurnsRaw((memory.turns = t));
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [turns, thinking]);

  const w = con.state?.wallet;
  const blocked = con.offline ? 'Setup required: the chat runs where the demo wallet server is configured.' : con.state && !w?.ok ? `Setup required: ${w?.error ?? 'OBORO_BUYER_WALLET_DIR'}` : null;
  const disabled = !!blocked || !con.state || thinking;

  async function send(msg: string) {
    const m = msg.trim();
    if (!m || disabled) return;
    setError(null); setText('');
    const optimistic = [...turns, { role: 'user' as const, text: m, at: new Date().toISOString() }];
    setTurns(optimistic); setThinking(true);
    try {
      const r = await chatAgent(sessionId, m);
      setSessionRaw((memory.sessionId = r.sessionId));
      setTurns(r.turns);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setThinking(false); }
  }

  return (
    <Shell active="agent" status={status} state={state}>
      <main className="wrap agent">
        <header className="agent-head">
          <span className="r-label">Example · examples/shopping-agent</span>
          <h1>A chat agent that shops here.</h1>
          <p>
            One of three example clients. An LLM with four tools, each one SDK call to the relay. It shows you the ZEC price first
            and buys only after your yes, checked in code. <a href={SOURCE} target="_blank" rel="noreferrer">Read the source →</a>
          </p>
        </header>

        <section className="chat" aria-label="Chat with the example agent">
          <div className="chat-top">
            <span className={`r-dot ${blocked ? 'off' : ''}`} />
            <span>Agent wallet</span>
            <span className="mono">{w?.balanceZats !== undefined ? `${(w.balanceZats / 1e8).toFixed(5)} TAZ` : '—'}</span>
            <span className="hide-s mute">spent today {(w?.spentTodayZats ?? 0).toLocaleString()} / {(w?.dailyCapZats ?? 0).toLocaleString()} zats</span>
          </div>

          <div className="chat-log" ref={log} aria-live="polite">
            {turns.length === 0 ? (
              <div className="hello">
                <Logo size={40} />
                <h2>What should it buy?</h2>
                <p>Real gift cards and phone recharges from the relay, paid in shielded Zcash over Nym.</p>
                <div className="sugg">
                  {SUGGEST.map((q) => (
                    <button key={q} disabled={disabled} onClick={() => send(q)}>{q}</button>
                  ))}
                </div>
              </div>
            ) : (
              turns.map((t, i) => t.role === 'user' ? (
                <div key={i} className="m me"><p>{t.text}</p></div>
              ) : (
                <div key={i} className="m bot">
                  <span className="av" aria-hidden="true"><Logo size={18} /></span>
                  <div className="body">
                    {t.tools?.length ? <Calls tools={t.tools} /> : null}
                    <p>{t.text.split(/\*\*(.+?)\*\*/g).map((part, k) => (k % 2 ? <strong key={k}>{part}</strong> : part))}</p>
                    {t.runId ? <Purchase id={t.runId} /> : null}
                  </div>
                </div>
              ))
            )}
            {thinking ? (
              <div className="m bot"><span className="av" aria-hidden="true"><Logo size={18} /></span><div className="typing" aria-label="Thinking"><i /><i /><i /></div></div>
            ) : null}
          </div>

          {error || blocked ? <p className="chat-note" role="status">{error ?? blocked}</p> : null}
          <form className="compose" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask it to buy a gift card…" disabled={disabled} aria-label="Message the example agent" maxLength={600} />
            <button disabled={disabled || !text.trim()} aria-label="Send">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
            </button>
          </form>
        </section>
      </main>
    </Shell>
  );
}

function Calls({ tools }: { tools: ToolTrace[] }) {
  return (
    <ul className="calls" aria-label="Tool calls">
      {tools.map((x, j) => (
        <li key={j} className={x.ok ? '' : 'bad'}>
          <span className="mono">{TOOL[x.name] ?? x.name}</span>
          <span>{x.summary}</span>
        </li>
      ))}
    </ul>
  );
}

const STEPS = [
  ['paying', 'Paid'], ['verifying', 'Verified'], ['buying', 'Ordered'], ['delivered', 'Delivered'],
] as const;
const RANK = ['quote', 'paying', 'paid', 'verifying', 'buying', 'delivered'];

function Purchase({ id }: { id: string }) {
  const run = useRun(id);
  if (!run) return null;
  const at = RANK.indexOf(run.stage === 'paid' ? 'verifying' : run.stage);
  return (
    <div className="buy">
      <div className="buy-top">
        <b>{run.quote ? (kindOf(run.quote) === 'recharge' ? `${run.quote.name.replace(/ Bundles India$/, '')} · ${plan(run.quote.value).data}` : `${run.quote.name} · ${inr(run.quote.value, run.quote.currency)}`) : 'Purchase'}</b>
        {run.txid ? <a className="mono" href={explorerTx(run.txid)} target="_blank" rel="noreferrer">{shortTx(run.txid)}</a> : null}
      </div>
      <div className="buy-steps">
        {STEPS.map(([k, label]) => {
          const i = RANK.indexOf(k);
          const cls = run.stage === 'failed' ? '' : i < at || run.stage === 'delivered' ? 'done' : i === at ? 'now' : '';
          return <span key={k} className={cls}>{label}</span>;
        })}
      </div>
      {run.stage === 'delivered' && run.result ? (kindOf(run.quote) === 'recharge'
        ? <p className="r-note mono">Recharged {run.result.phone_masked ?? ''} · Bitrefill invoice {run.result.invoice_id}</p>
        : <CodeTicket runId={id} run={run} />) : null}
      {run.stage === 'failed' ? <p className="r-note" style={{ color: 'var(--bad)' }}>{run.error}</p> : null}
    </div>
  );
}
