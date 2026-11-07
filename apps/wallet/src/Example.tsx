import { useEffect, useRef, useState } from 'react';
import { chatAgent, explorer, short, zec, chainName, type ChatTurn, type ShopRun, type ToolTrace } from './api';
import { Logo, Nav } from './chrome';
import { useConsole } from './useConsole';
import { useShop } from './Wallet';

const SOURCE_URL = 'https://github.com/nickthelegend/oboro/blob/main/examples/shopping-agent/agent.ts';

// Each of the agent's five tools is one call on the SDK's merchant client.
const TOOL_LABEL: Record<string, { label: string; sdk: string }> = {
  shop_rules: { label: 'Read the merchant’s rules', sdk: 'shop.rules()' },
  search_products: { label: 'Searched the catalog', sdk: 'shop.search(q)' },
  get_product: { label: 'Checked live prices', sdk: 'shop.product(id)' },
  buy: { label: 'Paid from the wallet', sdk: 'shop.buy({…})' },
  check_purchase: { label: 'Checked the order', sdk: 'shop.receipt(id)' },
};

const SUGGEST = [
  { q: 'What can you buy me for under a dollar?', note: 'reads the merchant’s rules' },
  { q: 'Get me ₹50 of Swiggy credit', note: 'inside the limit: pays and buys' },
  { q: 'Buy me ₹250 of Swiggy credit', note: 'over the limit: asks you first' },
  { q: 'How much have you spent today?', note: 'reads the wallet budget' },
];

export function Example() {
  const [tab, setTab] = useState<'chat' | 'source'>('chat');
  return (
    <div className="page">
      <Nav active="examples" />
      <main className="app ex">
        <header className="ex-head">
          <span className="ex-tag mono">Example · examples/shopping-agent</span>
          <h1>A shopping agent, built on the wallet.</h1>
          <p>
            An LLM with five tools, and every tool is one SDK call. It can only spend through its Oboro wallet, inside your
            limits. Swap in your own model or prompt; the wallet stays the same.
          </p>
          <div className="seg" role="tablist" aria-label="View">
            <button role="tab" aria-selected={tab === 'chat'} className={`seg-item ${tab === 'chat' ? 'on' : ''}`} onClick={() => setTab('chat')}>
              Try it
            </button>
            <button role="tab" aria-selected={tab === 'source'} className={`seg-item ${tab === 'source' ? 'on' : ''}`} onClick={() => setTab('source')}>
              Source
            </button>
          </div>
        </header>
        {tab === 'chat' ? <ChatPane /> : <SourcePane />}
      </main>
    </div>
  );
}

// The conversation survives tab switches (approve in the Wallet, come back), for this page load only.
const memory: { turns: ChatTurn[]; sessionId: string } = { turns: [], sessionId: '' };

function ChatPane() {
  const { state, offline } = useConsole(4000);
  const { shop } = useShop(2000);
  const [turns, setTurnsState] = useState<ChatTurn[]>(memory.turns);
  const [sessionId, setSessionIdState] = useState(memory.sessionId);
  const setTurns = (u: ChatTurn[] | ((t: ChatTurn[]) => ChatTurn[])) =>
    setTurnsState((prev) => (memory.turns = typeof u === 'function' ? u(prev) : u));
  const setSessionId = (id: string) => setSessionIdState((memory.sessionId = id));
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [turns, thinking]);

  const w = state?.wallet;
  const blocked = offline
    ? 'Setup required: live chat runs where a wallet server is configured (this page can’t reach one).'
    : state && !w?.ok
      ? `Setup required: ${w?.error ?? 'OBORO_BUYER_WALLET_DIR'}`
      : state && !state.gate.ok
        ? 'Setup required: the merchant gateway’s Nym gate is not running.'
        : null;
  const disabled = !!blocked || !state || thinking;

  async function send(msg: string) {
    const m = msg.trim();
    if (!m || disabled) return;
    setError(null);
    setText('');
    setTurns((t) => [...t, { role: 'user', text: m, at: new Date().toISOString() }]);
    setThinking(true);
    try {
      const r = await chatAgent(sessionId, m);
      setSessionId(r.sessionId);
      setTurns(r.turns);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setThinking(false);
    }
  }

  return (
    <section className="chat-card" aria-label="Chat with the example agent">
      <div className="chat-bar">
        <span className={`dot ${blocked ? 'dot-off' : ''}`} />
        <span>Wallet</span>
        <span className="mono">{w?.balanceZats !== undefined ? `${zec(w.balanceZats)} ${chainName() === 'mainnet' ? 'ZEC' : 'TAZ'}` : '—'}</span>
        <span className="chat-bar-sep hide-sm">·</span>
        <span className="hide-sm">spent today</span>
        <span className="mono hide-sm">
          {(w?.spentTodayZats ?? 0).toLocaleString('en-US')} / {(w?.dailyCapZats ?? 0).toLocaleString('en-US')} zats
        </span>
        <a className="chat-bar-link" href="#/wallet">Open wallet →</a>
      </div>

      <div className="chat-scroll" ref={log} aria-live="polite">
        {turns.length === 0 ? (
          <div className="chat-hello">
            <Logo size={44} />
            <h2>What should it buy?</h2>
            <p className="fine">Real Bitrefill products, paid in shielded Zcash over Nym. Over $1.00, it asks you first.</p>
            <div className="suggest">
              {SUGGEST.map((s) => (
                <button key={s.q} className="suggest-card" disabled={disabled} onClick={() => send(s.q)}>
                  <span>{s.q}</span>
                  <span className="fine">{s.note}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) =>
            t.role === 'user' ? (
              <div key={i} className="msg msg-user"><p>{t.text}</p></div>
            ) : (
              <div key={i} className="msg msg-agent">
                <span className="msg-avatar" aria-hidden="true"><Logo size={22} /></span>
                <div className="msg-body">
                  {t.tools && t.tools.length > 0 && <ToolCalls tools={t.tools} />}
                  <p>{t.text}</p>
                  {t.runId && <PurchaseCard run={shop?.runs.find((r) => r.id === t.runId)} />}
                </div>
              </div>
            ),
          )
        )}
        {thinking && (
          <div className="msg msg-agent">
            <span className="msg-avatar" aria-hidden="true"><Logo size={22} /></span>
            <div className="typing" aria-label="Thinking"><span /><span /><span /></div>
          </div>
        )}
      </div>

      {(error || blocked) && <p className="chat-note" role="status">{error ?? blocked}</p>}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask it to buy something…"
          disabled={disabled}
          aria-label="Message the example agent"
          maxLength={600}
        />
        <button className="send" disabled={disabled || !text.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
          </svg>
        </button>
      </form>
    </section>
  );
}

function ToolCalls({ tools }: { tools: ToolTrace[] }) {
  const [open, setOpen] = useState(false);
  const nym = tools.reduce((a, t) => a + (t.mixMs ?? 0), 0);
  return (
    <div className={`calls ${open ? 'open' : ''}`}>
      <button className="calls-sum" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="mono">{tools.length} wallet call{tools.length === 1 ? '' : 's'}</span>
        {nym > 0 && <span className="fine">· {(nym / 1000).toFixed(1)} s through Nym</span>}
        <span className="calls-chev" aria-hidden="true">›</span>
      </button>
      <ol className="calls-list">
        {tools.map((x, j) => (
          <li key={j} className={x.ok ? '' : 'bad'}>
            <span className="calls-dot" />
            <span className="calls-name">{TOOL_LABEL[x.name]?.label ?? x.name}</span>
            <span className="mono calls-sdk">{TOOL_LABEL[x.name]?.sdk ?? x.name}</span>
            <span className="calls-what">{x.summary}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const STAGES: { key: string; label: string; done: string[] }[] = [
  { key: 'pay', label: 'Paid', done: ['paid'] },
  { key: 'verify', label: 'Verified', done: ['settled'] },
  { key: 'order', label: 'Ordered', done: ['approved', 'processing', 'delivered', 'bitrefill'] },
  { key: 'done', label: 'Delivered', done: ['delivered'] },
];

function PurchaseCard({ run }: { run?: ShopRun }) {
  if (!run) return null;
  const types = new Set(run.steps.map((s) => s.type));
  if (run.status === 'delivered') types.add('delivered');
  const parked = run.status === 'needs_approval';
  const failed = run.status === 'failed' || run.status === 'refused';
  const firstOpen = STAGES.findIndex((s) => !s.done.some((d) => types.has(d)));
  return (
    <div className={`buy-card ${parked ? 'parked' : ''} ${failed ? 'failed' : ''}`}>
      <div className="buy-top">
        <div>
          <div className="buy-name">{run.product ? `${run.product.name} · ₹${run.product.value}` : 'Purchase'}</div>
          <div className="fine">{run.product ? `$${run.product.usd.toFixed(2)} from the merchant’s Bitrefill credit` : 'Reading the catalog…'}</div>
        </div>
        <span className={`status s-${run.status === 'delivered' ? 'paid' : parked ? 'warn' : failed ? 'failed' : 'running'}`}>
          {parked ? 'needs you' : run.status.replace('_', ' ')}
        </span>
      </div>
      <ol className="stages">
        {STAGES.map((s, i) => {
          const done = s.done.some((d) => types.has(d));
          const live = !done && i === firstOpen && !failed && !parked;
          const wait = !done && i === firstOpen && parked;
          return (
            <li key={s.key} className={done ? 'done' : live ? 'live' : wait ? 'wait' : ''}>
              <span className="stage-dot" />
              <span>{wait ? 'Your approval' : s.label}</span>
            </li>
          );
        })}
      </ol>
      {parked && (
        <a className="btn btn-moon btn-sm buy-cta" href="#/wallet">
          Approve in your wallet <span aria-hidden="true">→</span>
        </a>
      )}
      <div className="buy-foot">
        {run.txid && (
          <a className="mono link-quiet" href={explorer(run.txid)} target="_blank" rel="noreferrer">
            tx {short(run.txid, 8, 6)} ↗
          </a>
        )}
        {run.invoiceId && <span className="mono">invoice {short(run.invoiceId, 8, 4)}</span>}
        {run.error && <span className="bad-text">{run.error}</span>}
      </div>
    </div>
  );
}

function SourcePane() {
  const [src, setSrc] = useState<{ file: string; lines: number; source: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/examples/shopping-agent/source')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => alive && setSrc(b))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, []);
  return (
    <section className="source-card" aria-label="Source of the example agent">
      <div className="source-bar">
        <span className="mono">{src?.file ?? 'examples/shopping-agent/agent.ts'}</span>
        <span className="fine">{src ? `${src.lines} lines · the file this page runs` : ''}</span>
        <a className="link-quiet" href={SOURCE_URL} target="_blank" rel="noreferrer">GitHub ↗</a>
      </div>
      <div className="source-map">
        {Object.entries(TOOL_LABEL).map(([tool, t]) => (
          <span key={tool}><span className="mono">{tool}</span> → <span className="mono moon">{t.sdk}</span></span>
        ))}
      </div>
      {src ? (
        <pre className="source-code"><code>{src.source.split('\n').map((l, i) => (
          <span className="ln" key={i}><span className="ln-n">{i + 1}</span>{l || ' '}{'\n'}</span>
        ))}</code></pre>
      ) : (
        <p className="empty source-empty">
          {err ? <>The wallet server isn’t reachable here ({err}). Read it on <a className="link" href={SOURCE_URL} target="_blank" rel="noreferrer">GitHub</a>.</> : 'Loading the source…'}
        </p>
      )}
    </section>
  );
}
