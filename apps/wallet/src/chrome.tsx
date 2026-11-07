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

const TABS = [
  ['overview', '#/', 'Overview'],
  ['wallet', '#/wallet', 'Wallet'],
  ['examples', '#/examples', 'Example agent'],
  ['console', '#/console', 'Developers'],
] as const;
export type NavTab = (typeof TABS)[number][0];

export function Nav({ active = 'overview' }: { active?: NavTab }) {
  return (
    <nav className="nav" aria-label="Main">
      <a className="brand" href="#/" aria-label="Oboro home">
        <Logo />
        <span>Oboro</span>
        <span className="brand-kanji" aria-hidden="true">
          朧
        </span>
      </a>
      <div className="seg nav-seg">
        {TABS.map(([key, href, label]) => (
          <a key={key} href={href} className={`seg-item ${active === key ? 'on' : ''}`} aria-current={active === key ? 'page' : undefined}>
            {key === 'examples' ? (
              <>
                Example<span className="hide-xs">&nbsp;agent</span>
              </>
            ) : (
              label
            )}
          </a>
        ))}
      </div>
      <div className="nav-actions">
        <span className="net-pill mono hide-sm">{chainName()}</span>
        <a className="icon-btn" href="https://github.com/nickthelegend/oboro" target="_blank" rel="noreferrer" aria-label="Oboro on GitHub">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
          </svg>
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
          <p className="footer-line">Private payments infrastructure: shielded Zcash, over the Nym mixnet.</p>
        </div>
        <div className="footer-cols">
          <div>
            <h4>Product</h4>
            <a href="#sdk">Wallet SDK</a>
            <a href="#/wallet">Wallet app</a>
            <a href="#/examples">Example agent</a>
            <a href="#/console">Developer console</a>
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
