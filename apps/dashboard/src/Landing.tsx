import { useEffect, useState } from 'react';
import { explorer, getShop, short, zec, type ShopPurchase } from './api';
import { Logo, Nav, Footer } from './chrome';
import { useConsole, useProof } from './useConsole';

const AGENT_CODE = `import { createAgent, ZingoWallet } from 'oboro';

const kumo = createAgent({
  tunnelUrl: 'http://127.0.0.1:7410',        // local oboro-node tunnel
  wallet: new ZingoWallet({ dataDir: process.env.KUMO_WALLET! }),
  policy: { maxPerRequestZats: 50_000, dailyCapZats: 300_000 },
});

// 402 -> policy -> shielded payment -> retry, all over the mixnet
const res = await kumo.fetch(\`nym://\${TSUKI}/v1/intel/tip\`);`;

const SELLER_CODE = `import express from 'express';
import { createPaywall, ZingoViewVerifier } from 'oboro';

const paywall = createPaywall({
  payTo: process.env.TSUKI_ADDRESS!,            // shielded unified address
  verifier: new ZingoViewVerifier({ dataDir: '.oboro/view' }), // viewing key only
  stateFile: '.oboro/paywall.json',
});

const app = express();
app.get('/v1/intel/tip', paywall.price(2_000, 'Live testnet tip'), tip);
app.listen(7420, '127.0.0.1');   // no public port: oboro-node gate is the only door`;

const MCP_CODE = `{
  "mcpServers": {
    "oboro": {
      "command": "node",
      "args": ["packages/mcp/dist/index.js"],
      "env": {
        "OBORO_TUNNEL_URL": "http://127.0.0.1:7410",
        "OBORO_SELLER_NYM_ADDRESS": "<Tsuki's Nym address>",
        "OBORO_BUYER_WALLET_DIR": "<Kumo's zingo wallet dir>"
      }
    }
  }
}
// tools: oboro_fetch · oboro_budget · oboro_status
//        oboro_shop_search · oboro_shop_product · oboro_shop_buy · oboro_shop_receipt`;

const LEAKS = [
  { row: 'Who paid whom, on chain', plain: 'Public', shielded: 'Hidden', oboro: 'Hidden' },
  { row: 'Amount, on chain', plain: 'Public', shielded: 'Hidden', oboro: 'Hidden' },
  { row: "Agent's IP, at the seller", plain: 'Seen', shielded: 'Seen', oboro: 'Never reaches it' },
  { row: "Seller's IP, at the agent", plain: 'Seen', shielded: 'Seen', oboro: 'No public endpoint' },
  { row: 'Request-to-payment link, for a network watcher', plain: 'Trivial', shielded: 'Timing + IP', oboro: 'Mixed with cover traffic' },
  { row: 'Broadcasting the payment', plain: 'From your IP', shielded: 'From your IP', oboro: 'Over Nym (zingo Mixnet Mode)' },
];

const STEPS = [
  {
    n: '01',
    t: 'The call crosses the mist',
    d: 'Kumo asks Tsuki for data. oboro-node wraps the HTTP request in Sphinx packets and sends it through the Nym entry gateway and three mix layers to Tsuki’s Nym address. Tsuki has no public port at all.',
  },
  {
    n: '02',
    t: '402, answered on a reply-only path',
    d: 'Tsuki answers 402 Payment Required with an x402 challenge: price in zatoshis, a shielded address and a one-time nonce. The answer rides single-use reply blocks, so Tsuki never learns where Kumo is.',
  },
  {
    n: '03',
    t: 'Paid in shielded Zcash',
    d: 'Kumo checks its spend policy, then pays the exact price to Tsuki’s shielded address with the nonce in the encrypted memo. The wallet broadcasts it over Nym too.',
  },
  {
    n: '04',
    t: 'Proof, verified with a viewing key',
    d: 'Kumo retries with X-PAYMENT. Tsuki’s server holds only a viewing key: it finds the note, checks memo and amount, redeems the nonce once and serves 200.',
  },
];

const FAQ = [
  {
    q: 'What does the seller actually learn?',
    a: 'That a request arrived over the mixnet and that a shielded note with the right memo and amount landed in its wallet. No IP address, no Nym address of the caller (replies use single-use reply blocks), no payer address.',
  },
  {
    q: 'Why not just shielded x402?',
    a: 'A shielded payment hides the money, but the HTTP request still comes from an IP at a time. Anyone who sees the request and the payment window can link them. Oboro moves the request itself into the mixnet.',
  },
  {
    q: 'Who holds which keys?',
    a: 'The buyer agent’s wallet holds its spending key and runs locally. The seller’s web server holds only an incoming viewing key, so it can confirm payments but cannot spend. oboro-node holds only Nym identity keys.',
  },
  {
    q: 'What does it not hide?',
    a: 'The seller sees the amount it was paid and what was asked for. A global observer with very little other traffic could still try timing analysis; Nym’s cover traffic and mixing delays are what push back on that. Payments wait for one block (about 25 s on NU7 testnet) plus the seller’s viewing-key sync.',
  },
  {
    q: 'Is this production ready?',
    a: 'No. It runs on Zcash testnet and the Nym mainnet mixnet, built in one day at the Zcash Free Society Hack. The SDK, the node and the protocol are open source under MIT.',
  },
];


const SHOP_FLOW = [
  { t: 'Browse, through the mixnet', d: 'Kumo reads Tsuki’s catalog over Nym. Tsuki fetches it from Bitrefill: real products, real stock, real USD prices.' },
  { t: 'Pay in the dark', d: 'Tsuki answers 402. Kumo checks its own spend policy, then pays 5,000 zats in shielded testnet ZEC, broadcast over Nym.' },
  { t: 'Buy inside the caps', d: 'Tsuki verifies the note with a viewing key, reserves the txid, then creates a Bitrefill invoice paid from its balance.' },
  { t: 'Delivered, not just paid', d: 'Tsuki polls the invoice and the order until Bitrefill says delivered. The code lands in Tsuki’s Bitrefill account; the buyer’s copy comes back only in its paid response, masked everywhere else.' },
];
const GUARANTEES: [string, string][] = [
  ['Allow-list', 'Only listed products and values'],
  ['Caps', '$1.00 per purchase, $3.00 and 3 buys per day'],
  ['Above the cap', 'Nothing is bought; a human approves out of band'],
  ['Replay', 'One purchase per Zcash txid, reserved before the invoice'],
  ['Codes', 'Never logged; masked everywhere but the buyer’s paid response'],
];

function usePurchases(): ShopPurchase[] {
  const [rows, setRows] = useState<ShopPurchase[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = () => getShop().then((s) => alive && setRows(s.tsuki.ledger ?? [])).catch(() => undefined);
    tick();
    const t = window.setInterval(tick, 5000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);
  return rows;
}

export function Landing() {
  const { state, offline } = useConsole(4000);
  const proof = useProof();
  const [tab, setTab] = useState<'agent' | 'seller' | 'mcp'>('agent');

  const paid = state?.seller.ledger.filter((r) => r.status === 'paid') ?? [];
  const lastPaid = paid[paid.length - 1];
  const lastRun = state?.runs.find((r) => r.status === 'paid');
  const served = state?.gate.served;
  const recorded = !state && proof ? proof[proof.length - 1] : null;
  const purchases = usePurchases();
  const delivered = purchases.filter((p) => p.status === 'delivered');
  const lastBuy = delivered[delivered.length - 1];

  return (
    <div className="page">
      <Nav />

      <header className="hero frame">
        <img className="hero-art" src="/hero-moon-mist.jpg" alt="" aria-hidden="true" />
        <div className="hero-shade" aria-hidden="true" />
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="dot" /> x402 · Nym mixnet · shielded Zcash
          </span>
          <h1>
            Agents pay
            <br />
            in the dark.
          </h1>
          <p className="lede">
            Oboro carries an AI agent’s HTTP request and its Zcash payment through the Nym mixnet. The seller gets paid
            and serves the call, or buys a real gift card on Bitrefill, without learning who called, from where, or which
            wallet paid.
          </p>
          <div className="ctas">
            <a className="btn btn-moon" href="#/console">
              Open the console <span aria-hidden="true">→</span>
            </a>
            <a className="btn btn-ghost" href="#/shop">
              Send Kumo shopping
            </a>
          </div>
        </div>

        <aside className="hero-cards" aria-label="Live status">
          <div className="glass card-saw">
            <div className="glass-head">
              <span className="chip">{state ? 'Live' : recorded ? 'Recorded run' : 'Offline'}</span>
              What Tsuki, the seller, saw
            </div>
            <dl className="saw">
              <dt>Client IP</dt>
              <dd className="moon">none</dd>
              <dt>Caller’s Nym address</dt>
              <dd className="moon">none · reply blocks only</dd>
              <dt>Payer address</dt>
              <dd className="moon">none · shielded</dd>
            </dl>
          </div>
          <div className="glass card-pay">
            <div className="glass-head">Last payment</div>
            {lastPaid?.txid || lastRun?.txid || recorded ? (
              <>
                <div className="big-num">
                  {(lastPaid?.priceZats ?? lastRun?.priceZats ?? recorded?.priceZats ?? 0).toLocaleString('en-US')}
                  <small> zats</small>
                </div>
                <a
                  className="mono link"
                  href={explorer((lastPaid?.txid ?? lastRun?.txid ?? recorded?.txid)!)}
                  target="_blank"
                  rel="noreferrer"
                >
                  tx {short(lastPaid?.txid ?? lastRun?.txid ?? recorded?.txid, 10, 6)} ↗
                </a>
                {recorded && <p className="fine">Zcash testnet · {recorded.recordedAt}</p>}
              </>
            ) : (
              <p className="empty">{offline ? 'Console offline: no live payment to show.' : 'No payments yet.'}</p>
            )}
          </div>
        </aside>
      </header>

      <section className="stats" aria-label="Live counts">
        {state ? (
          <>
            <Stat n={served ?? 0} l="requests Tsuki served over the mixnet" />
            <Stat n={paid.length} l="payments settled in shielded ZEC" />
            <Stat n={zec(paid.reduce((a, r) => a + r.priceZats, 0))} l="TAZ paid to Tsuki (testnet ZEC)" />
            <Stat n={delivered.length} l="real Bitrefill purchases delivered" />
          </>
        ) : (
          <p className="stats-empty">
            Live counts appear when the console server is running.{' '}
            <a href="#/console" className="link">
              Open the console
            </a>
          </p>
        )}
      </section>

      <section className="section" id="why">
        <div className="section-head">
          <span className="eyebrow">The second leak</span>
          <h2>A private payment still arrives from somewhere.</h2>
          <p className="sub">
            Shielded x402 hides the money. But the HTTP call that triggered it comes from an IP, at a moment, to a
            server. Put the two side by side and the agent is no longer anonymous. Oboro closes the network leak too.
          </p>
        </div>
        <div className="leaks" role="table" aria-label="What each approach exposes">
          <div className="leaks-row leaks-headrow" role="row">
            <span role="columnheader" />
            <span role="columnheader">x402 on a public chain</span>
            <span role="columnheader">Shielded x402</span>
            <span role="columnheader" className="moon">
              Oboro
            </span>
          </div>
          {LEAKS.map((l) => (
            <div className="leaks-row" role="row" key={l.row}>
              <span role="rowheader">{l.row}</span>
              <span role="cell" className="bad">
                {l.plain}
              </span>
              <span role="cell" className={l.shielded === 'Hidden' ? 'good' : 'bad'}>
                {l.shielded}
              </span>
              <span role="cell" className="good moon">
                {l.oboro}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="section" id="how">
        <div className="section-head">
          <span className="eyebrow">How a paid call travels</span>
          <h2>Five veils between the agents.</h2>
        </div>
        <figure className="veil-figure frame">
          <img src="/veils.jpg" alt="A packet of light weaving through five veils of mist toward the moon" />
          <figcaption className="veil-labels" aria-hidden="true">
            <span>Kumo</span>
            {['Entry gateway', 'Mix layer 1', 'Mix layer 2', 'Mix layer 3', 'Tsuki’s gateway'].map((v) => (
              <span key={v}>{v}</span>
            ))}
          </figcaption>
        </figure>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.n} className="step">
              <img className="step-art" src={`/step-${i + 1}.jpg`} alt="" width={160} height={160} loading="lazy" />
              <span className="step-n mono">{s.n}</span>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </li>
          ))}
        </ol>
      </section>


      <section className="section" id="shop">
        <div className="section-head">
          <span className="eyebrow">Shopping superpower · Bitrefill</span>
          <h2>It buys real things, too.</h2>
          <p className="section-lede">
            The same rail pays for goods. Kumo, with no Bitrefill account, no card and no exposed IP, pays Tsuki in shielded
            ZEC over Nym. That payment authorises one real Bitrefill purchase, which Tsuki pays from its balance inside
            hard caps. Bitrefill delivers; nobody upstream learns which agent asked.
          </p>
        </div>
        <div className="shop-promo">
          <ol className="shop-flow">
            {SHOP_FLOW.map((f, i) => (
              <li key={f.t}>
                <span className="mono step-n">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <h3>{f.t}</h3>
                  <p>{f.d}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="shop-guarantees glass">
            <div className="glass-head">Guarantees, in code</div>
            <ul>
              {GUARANTEES.map(([k, v]) => (
                <li key={k}>
                  <span className="moon">{k}</span>
                  <span>{v}</span>
                </li>
              ))}
            </ul>
            <a className="btn btn-moon" href="#/shop">
              Open the shop <span aria-hidden="true">→</span>
            </a>
          </div>
          <div className="glass last-buy">
            <div className="glass-head">
              <span className="chip">{lastBuy ? 'Delivered' : 'Live'}</span> Last real purchase
            </div>
            {lastBuy ? (
              <dl className="saw">
                <dt>Product</dt>
                <dd className="moon">{lastBuy.product_id} · ₹{lastBuy.value}</dd>
                <dt>Paid by Tsuki</dt>
                <dd>${lastBuy.usd.toFixed(2)} store credit</dd>
                <dt>Bitrefill invoice</dt>
                <dd className="mono">{short(lastBuy.invoice_id, 8, 4)}</dd>
                <dt>Authorised by</dt>
                <dd className="mono">{lastBuy.txid}</dd>
              </dl>
            ) : (
              <p className="empty">No purchase delivered yet. The first one shows its Bitrefill invoice ID here.</p>
            )}
          </div>
        </div>
      </section>

      <section className="section" id="sdk">
        <div className="section-head">
          <span className="eyebrow">Pluggable SDK</span>
          <h2>Ten lines on each side.</h2>
          <p className="sub">
            Agents get a <code>fetch</code> that speaks x402 over Nym. Sellers get an Express paywall that verifies with a
            viewing key. Any MCP-capable model gets seven tools, shopping included.
          </p>
        </div>
        <div className="code-card frame">
          <div className="tabs" role="tablist">
            {(
              [
                ['agent', 'Agent (buyer)'],
                ['seller', 'Seller'],
                ['mcp', 'MCP'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                className={`tab ${tab === k ? 'on' : ''}`}
                onClick={() => setTab(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <pre className="code">
            <code>{tab === 'agent' ? AGENT_CODE : tab === 'seller' ? SELLER_CODE : MCP_CODE}</code>
          </pre>
        </div>
      </section>

      <section className="section faq frame" id="faq">
        <div className="section-head">
          <span className="eyebrow">Questions</span>
          <h2>What hides, and what doesn’t.</h2>
        </div>
        <div className="faq-list">
          {FAQ.map((f) => (
            <details key={f.q} className="faq-item">
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <Footer />
      <span className="sr-only">
        <Logo />
      </span>
    </div>
  );
}

function Stat({ n, l }: { n: number | string; l: string }) {
  return (
    <div className="stat">
      <div className="stat-n">{typeof n === 'number' ? n.toLocaleString('en-US') : n}</div>
      <div className="stat-l">{l}</div>
    </div>
  );
}
