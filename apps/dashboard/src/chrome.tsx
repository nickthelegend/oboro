import { chainName } from './api';
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <clipPath id="oboro-moon">
          <circle cx="32" cy="32" r="26" />
        </clipPath>
      </defs>
      <circle cx="32" cy="32" r="26" fill="var(--moon)" />
      <g clipPath="url(#oboro-moon)" fill="var(--night)">
        <rect x="4" y="24" width="30" height="2.6" />
        <rect x="4" y="30.7" width="56" height="2.6" />
        <rect x="27" y="37.4" width="33" height="2.6" />
      </g>
    </svg>
  );
}

export function Nav({ console = false }: { console?: boolean }) {
  return (
    <nav className="nav" aria-label="Main">
      <div className="nav-links">
        <a href="#/">Overview</a>
        <a href="#how" className="hide-sm">
          How it works
        </a>
        <a href="#layers" className="hide-sm">
          Layers
        </a>
        <a href="#sdk" className="hide-sm">
          SDK
        </a>
        <a href="https://github.com/nickthelegend/oboro" target="_blank" rel="noreferrer" className="hide-sm">
          GitHub
        </a>
      </div>
      <a className="brand" href="#/" aria-label="Oboro home">
        <Logo />
        <span>Oboro</span>
        <span className="brand-kanji" aria-hidden="true">
          朧
        </span>
      </a>
      <div className="nav-actions">
        <span className="net-pill mono">{chainName()}</span>
        <a className="nav-shop hide-sm" href="#/console">
          Developers
        </a>
        <a className={`btn ${console ? 'btn-ghost' : 'btn-moon'} btn-sm`} href="#/wallet">
          Open wallet
        </a>
      </div>
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="footer frame">
      <div className="footer-top">
        <div>
          <div className="footer-brand">
            <Logo size={40} />
            <span>Oboro</span>
          </div>
          <p className="footer-line">The private wallet for AI agents: shielded Zcash, over the Nym mixnet.</p>
        </div>
        <div className="footer-cols">
          <div>
            <h4>Product</h4>
            <a href="#/console">Developer console</a>
            <a href="#/wallet">Wallet</a>
            <a href="#sdk">SDK</a>
            <a href="#how">How it works</a>
          </div>
          <div>
            <h4>Built on</h4>
            <a href="https://nym.com" target="_blank" rel="noreferrer">
              Nym mixnet
            </a>
            <a href="https://z.cash" target="_blank" rel="noreferrer">
              Zcash
            </a>
            <a href="https://x402.org" target="_blank" rel="noreferrer">
              x402
            </a>
            <a href="https://www.bitrefill.com" target="_blank" rel="noreferrer">
              Bitrefill
            </a>
          </div>
        </div>
      </div>
      <div className="footer-bottom mono">
        <span>Zcash Free Society Hack · Mumbai · 4 Nov 2026</span>
        <span>MIT · © 2026 Nivesh Gajengi</span>
      </div>
      <div className="footer-word" aria-hidden="true">
        oboro
      </div>
    </footer>
  );
}

/** Role badge for the two sides of a payment: the agent's wallet and the merchant's gateway. */
export function RoleIcon({ who, size = 48 }: { who: 'wallet' | 'gateway'; size?: number }) {
  return (
    <span className={`role-icon role-${who}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {who === 'wallet' ? (
          <>
            <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" />
            <rect x="4" y="8" width="16" height="11" rx="2.5" />
            <path d="M16 13.5h2" />
          </>
        ) : (
          <>
            <path d="M4 10l1.5-5h13L20 10" />
            <path d="M4 10a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0" />
            <path d="M5.5 12.5V19h13v-6.5" />
            <path d="M10 19v-4h4v4" />
          </>
        )}
      </svg>
    </span>
  );
}
