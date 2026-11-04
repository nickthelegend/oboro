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
        <span className="net-pill mono">testnet</span>
        <a className="nav-shop hide-sm" href="#/shop">
          Shop
        </a>
        {!console ? (
          <a className="btn btn-moon btn-sm" href="#/console">
            Console
          </a>
        ) : (
          <a className="btn btn-ghost btn-sm" href="#/console">
            Console
          </a>
        )}
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
          <p className="footer-line">x402 over the Nym mixnet, paid in shielded Zcash.</p>
        </div>
        <div className="footer-cols">
          <div>
            <h4>Product</h4>
            <a href="#/console">Console</a>
            <a href="#/shop">Shop</a>
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
