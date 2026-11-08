import { useEffect, useState } from 'react';
import { GiftCard } from './GiftCard';
import { Shell } from './shell';
import { ago, inr, shortTx, explorerTx, stamp, usd, useRelay, zecOf, type RelayProduct, type RelayState } from './relay';

const NEVER_SAW = ['IP address', 'Nym address', 'payer address', 'account', 'email', 'phone number'];
const KNOWS = ['product', 'price', 'txid', 'time'];

export function Home({ section }: { section?: 'developers' }) {
  const { state, status } = useRelay();
  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [section]);
  const first = pickFirst(state.products);
  return (
    <Shell active={section ?? 'home'} status={status} state={state}>
      <main>
        <section className="r-hero wrap">
          <span className="r-eyebrow">
            <span className="tag">Live</span>
            Real Bitrefill cards · shielded Zcash · Nym mixnet
          </span>
          <h1>
            <span className="soft">The shop AI agents</span>
            <br />
            <span className="moon">buy from.</span>
          </h1>
          <p className="r-lede">
            Any agent gets a live quote, pays the <b>full price in shielded ZEC</b> with one x402 call over the Nym mixnet, and
            gets a real gift-card code back, <b>sealed so only that agent can open it</b>. We learn what sold. Never who bought it.
          </p>
          <div className="r-ctas">
            <a className="r-btn primary" href="#/store">
              Open the store <span className="arrow">→</span>
            </a>
            <a className="r-btn ghost" href="#/developers">
              Add it to your agent
            </a>
          </div>
          <div className="r-proof">
            <span>x402 over Nym</span><i />
            <span>Priced at the live ZEC rate</span><i />
            <span>SDK · MCP · any x402 client</span>
          </div>
        </section>

        <section className="wrap" aria-label="Live storefront">
          <div className="r-frame">
            <div className="r-frame-in">
              <div className="r-frame-bar">
                <span className="dots" aria-hidden="true"><i /><i /><i /></span>
                <span className="addr mono">nym://oboro-relay · POST /v1/cards/quote</span>
              </div>
              <LiveQuote state={state} status={status} product={first?.product} pkg={first?.pkg} />
            </div>
          </div>
        </section>

        <section className="r-sec wrap" aria-labelledby="how">
          <div className="r-sec-head">
            <span className="r-label">How it works</span>
            <h2 id="how">Three calls. <span className="dim">No account, no email, no IP.</span></h2>
            <p>Every request, the 402 challenge, the payment and the reply cross the Nym mixnet. The relay has no public port.</p>
          </div>
          <div className="steps">
            <div className="step">
              <span className="n mono">1</span>
              <h3>Quote</h3>
              <p>Bitrefill’s live price, converted at the live ZEC/USD rate. No markup, valid for ten minutes.</p>
              <div className="code">
                <span className="k">const</span> q = <span className="k">await</span> cards.<span className="f">quote</span>(<span className="s">'blink-it-india'</span>, <span className="s">250</span>)
                {'\n'}<span className="c">// {first ? `${inr(first.pkg.value, first.product.currency)} → ${first.pkg.zats.toLocaleString()} zats` : 'live price in zats'}</span>
              </div>
            </div>
            <div className="step">
              <span className="n mono">2</span>
              <h3>Pay</h3>
              <p>One standard x402 payment in shielded Zcash. The relay checks it with a viewing key, then buys the card from its own balance.</p>
              <div className="code">
                <span className="k">const</span> card = <span className="k">await</span> cards.<span className="f">buy</span>(q.quote_id)
                {'\n'}<span className="c">// 402 → shielded tx → paid retry, over Nym</span>
              </div>
            </div>
            <div className="step">
              <span className="n mono">3</span>
              <h3>Open</h3>
              <p>The code comes back sealed to a key made for this one purchase. If the order fails, the ZEC is refunded to a shielded address.</p>
              <div className="code">
                card.code <span className="c">// opened locally, never in a log</span>
                {'\n'}<span className="c">// MCP: saved to a file, kept out of the model</span>
              </div>
            </div>
          </div>
        </section>

        <section className="r-sec wrap" aria-labelledby="knows">
          <div className="r-sec-head">
            <span className="r-label">What we store</span>
            <h2 id="knows">We know what sold. <span className="dim">Never who bought it.</span></h2>
            <p>This is the relay’s own record, served live from its public endpoint. Nothing else is kept.</p>
          </div>
          <div className="ledger">
            <div className="panel">
              <h3>Last sale, as stored</h3>
              <p className="sub mono">GET /oboro/relay</p>
              <LastSale state={state} status={status} />
            </div>
            <div className="panel">
              <h3>Never received</h3>
              <p className="sub">The relay can’t store what never reaches it.</p>
              <div className="chips">
                {(state.relay_never_saw.length ? state.relay_never_saw : NEVER_SAW).map((x) => (
                  <span key={x} className="chip no"><s>{x}</s></span>
                ))}
              </div>
              <h3 style={{ marginTop: 28 }}>Stored per sale</h3>
              <div className="chips">
                {(state.relay_knows.length ? state.relay_knows : KNOWS).map((x) => (
                  <span key={x} className="chip yes">{x}</span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="r-sec wrap" id="developers" aria-labelledby="dev">
          <div className="r-sec-head">
            <span className="r-label">Developers</span>
            <h2 id="dev">Any agent can shop here.</h2>
            <p>Bring your own agent. The relay speaks x402, so a script, Claude Desktop or a chat agent all buy the same way.</p>
          </div>
          <Clients />
        </section>

        <section className="r-sec wrap" aria-labelledby="honest">
          <div className="r-sec-head">
            <span className="r-label">Honest limits</span>
            <h2 id="honest">What this is today.</h2>
          </div>
          <div className="limits">
            <div><h4>Testnet coins, real cards</h4><p>Agents pay in Zcash testnet coins, priced 1:1 at the mainnet ZEC rate. The cards are real and paid from the relay’s Bitrefill balance{typeof state.float_usd === 'number' ? ` (${usd(state.float_usd)} left)` : ''}.</p></div>
            <div><h4>You trust the relay to deliver</h4><p>The agent pays first. If Bitrefill fails, the relay refunds to the shielded address the agent named.</p></div>
            <div><h4>Wallet sync still sees an IP</h4><p>Payments and requests go over Nym; the agent’s own wallet sync to the light-wallet server does not yet.</p></div>
            <div><h4>One operator, low traffic</h4><p>Few sales make timing easier to correlate. More buyers make every buyer harder to pick out.</p></div>
          </div>
        </section>

        <section className="wrap">
          <div className="band">
            <h2>Give your agent a shop.</h2>
            <p>Real gift cards, real prices, and a seller that never learns who you are.</p>
            <div className="r-ctas">
              <a className="r-btn primary" href="#/store">Open the store <span className="arrow">→</span></a>
              <a className="r-btn ghost" href="https://github.com/nickthelegend/oboro" target="_blank" rel="noreferrer">View on GitHub</a>
            </div>
          </div>
        </section>
      </main>
    </Shell>
  );
}

function pickFirst(products: RelayProduct[]) {
  for (const product of products) {
    const pkg = product.packages.find((p) => p.available) ?? product.packages[0];
    if (pkg) return { product, pkg };
  }
  return undefined;
}

function LiveQuote({ state, status, product, pkg }: { state: RelayState; status: string; product?: RelayProduct; pkg?: RelayProduct['packages'][number] }) {
  const second = state.products.find((p) => p.product_id !== product?.product_id);
  const secondPkg = second?.packages[0];
  if (status === 'loading') return <div className="r-frame-body"><div><span className="r-label">Loading the live catalog…</span></div><div /></div>;
  if (!product || !pkg || !state.rate) {
    return (
      <div className="r-frame-body">
        <div className="setup" style={{ margin: 28 }}>
          <b>Relay not reachable from here</b>
          {state.setup.length ? `Setup required: ${state.setup.join(', ')}` : state.error ?? 'Live prices appear when the relay is online.'}
        </div>
        <div />
      </div>
    );
  }
  return (
    <div className="r-frame-body">
      <div>
        <span className="r-label">Live catalog</span>
        <div className="stack" style={{ marginTop: 18 }}>
          {second && secondPkg ? <GiftCard id={second.product_id} name={second.name} value={secondPkg.value} currency={second.currency} zats={secondPkg.zats} /> : <div />}
          <GiftCard id={product.product_id} name={product.name} value={pkg.value} currency={product.currency} zats={pkg.zats} />
        </div>
      </div>
      <div>
        <span className="r-label">Quote</span>
        <div className="rows">
          <div className="row"><span className="k">Card</span><span className="v">{product.name} · {inr(pkg.value, product.currency)}</span></div>
          <div className="row"><span className="k">Bitrefill price</span><span className="v mono">{usd(pkg.usd)}</span></div>
          <div className="row"><span className="k">ZEC / USD</span><span className="v mono">{state.rate.usd.toFixed(2)} · {state.rate.source} · {ago(state.rate.at)}</span></div>
          <div className="row"><span className="k">Delivery</span><span className="v">Sealed to the agent’s one-time key</span></div>
          <div className="row"><span className="k">Route</span><span className="v">Nym mixnet · relay has no public port</span></div>
          <div className="row total"><span className="k">Agent pays</span><span className="v mono">{zecOf(pkg.zats)} ZEC</span></div>
        </div>
        <p className="r-note mono">{pkg.zats.toLocaleString()} zats · {status === 'snapshot' ? `snapshot of the relay, ${stamp(state.captured_at)}` : 'live from the relay, refreshed every 15 s'}</p>
      </div>
    </div>
  );
}

function LastSale({ state, status }: { state: RelayState; status: string }) {
  const sale = state.sales[0];
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 10000); return () => clearInterval(t); }, []);
  if (!sale) return <div className="empty">{status === 'offline' ? 'Relay offline. The record appears when it is reachable.' : 'No sales yet. The first sale appears here, exactly as stored.'}</div>;
  return (
    <div className="rows">
      <div className="row"><span className="k">product</span><span className="v">{sale.name ?? sale.product_id} · {inr(sale.value, sale.currency)}</span></div>
      <div className="row"><span className="k">price</span><span className="v mono">{usd(sale.usd)} · {sale.zats.toLocaleString()} zats</span></div>
      <div className="row"><span className="k">txid</span><span className="v mono">{sale.txid.includes('…') ? sale.txid : <a href={explorerTx(sale.txid)} target="_blank" rel="noreferrer">{shortTx(sale.txid)}</a>}</span></div>
      <div className="row"><span className="k">time</span><span className="v mono">{new Date(sale.created_at).toISOString().replace('T', ' ').slice(0, 19)} UTC</span></div>
      <div className="row"><span className="k">status</span><span className="v">{sale.status}</span></div>
    </div>
  );
}

const CLIENTS = [
  {
    key: 'sdk', title: 'TypeScript SDK', note: 'Any script or agent framework',
    code: `import { createWallet, ZingoWallet } from 'oboro';

const wallet = createWallet({
  tunnelUrl: process.env.OBORO_TUNNEL_URL,          // local Nym tunnel
  wallet: new ZingoWallet({ dataDir: process.env.OBORO_BUYER_WALLET_DIR }),
  policy: { maxPerRequestZats: 300_000, dailyCapZats: 600_000, allowRecipients: [RELAY] },
});

const cards = wallet.cards(RELAY);                   // the relay's Nym address
const q = await cards.quote('blink-it-india', 250);  // live price in zats
const card = await cards.buy(q.quote_id, { refundTo: MY_SHIELDED_ADDRESS });
console.log(card.code);                              // opened locally`,
  },
  {
    key: 'mcp', title: 'Claude Desktop', note: 'MCP server, four tools',
    code: `// claude_desktop_config.json
{
  "mcpServers": {
    "oboro": {
      "command": "pnpm",
      "args": ["--filter", "@oboro/mcp", "exec", "node", "dist/index.js"],
      "env": {
        "OBORO_BUYER_WALLET_DIR": "…",
        "OBORO_SELLER_NYM_ADDRESS": "…",
        "OBORO_TUNNEL_URL": "http://127.0.0.1:7410"
      }
    }
  }
}

// tools: oboro_cards_catalog · oboro_cards_quote
//        oboro_cards_buy · oboro_cards_receipt
// the code is written to a local file, the model sees it masked`,
  },
  {
    key: 'agent', title: 'Chat agent', note: 'examples/shopping-agent',
    code: `// an LLM with four tools, each one SDK call
const agent = createShoppingAgent({ relay: wallet.cards(RELAY) });

await agent.chat('Get me a ₹250 Blinkit card');
// → catalog() → quote() → asks you, with the ZEC price
await agent.chat('Yes, buy it');
// → buy()  only after your yes, checked in code`,
  },
];

function Clients() {
  const [on, setOn] = useState('sdk');
  const c = CLIENTS.find((x) => x.key === on) ?? CLIENTS[0];
  return (
    <div className="clients">
      <div className="client-tabs" role="tablist" aria-label="Clients">
        {CLIENTS.map((x) => (
          <button key={x.key} role="tab" aria-selected={x.key === on} className={`client-tab ${x.key === on ? 'on' : ''}`} onClick={() => setOn(x.key)}>
            <b>{x.title}</b>
            <span>{x.note}</span>
          </button>
        ))}
      </div>
      <pre className="code" role="tabpanel">{c.code}</pre>
    </div>
  );
}
