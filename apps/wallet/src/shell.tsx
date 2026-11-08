import type { ReactNode } from 'react';
import { Logo } from './chrome';
import type { RelayState } from './relay';

const LINKS = [
  ['store', '#/store', 'Store'],
  ['agent', '#/agent', 'Example agent'],
  ['developers', '#/developers', 'Developers'],
] as const;
export type RTab = (typeof LINKS)[number][0] | 'home';

export function Shell({ active, status, state, children }: { active: RTab; status: 'loading' | 'ok' | 'offline'; state?: RelayState; children: ReactNode }) {
  const live = status === 'ok' && !!state?.rate && state.setup.length === 0;
  return (
    <div className="r">
      <header className="r-nav">
        <div className="wrap">
          <a className="r-brand" href="#/" aria-label="Oboro home">
            <Logo size={26} />
            <span>Oboro</span>
            <span className="k" aria-hidden="true">朧</span>
          </a>
          <nav className="r-links" aria-label="Main">
            {LINKS.map(([key, href, label]) => (
              <a key={key} href={href} className={active === key ? 'on' : ''} aria-current={active === key ? 'page' : undefined}>
                {label}
              </a>
            ))}
          </nav>
          <div className="right">
            <span className="r-pill mono" title={live ? 'Relay reachable over the Nym mixnet' : 'Relay not reachable from this page'}>
              <span className={`r-dot ${live ? '' : 'off'}`} />
              {status === 'loading' ? 'Connecting…' : live ? 'Relay live · Zcash testnet' : 'Relay offline'}
            </span>
            <a className="r-icon" href="https://github.com/nickthelegend/oboro" target="_blank" rel="noreferrer" aria-label="Oboro on GitHub">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
                <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
              </svg>
            </a>
          </div>
        </div>
      </header>
      {children}
      <footer className="r-foot">
        <div className="wrap">
          <span>Oboro 朧 · gift cards for AI agents, paid in shielded Zcash over the Nym mixnet</span>
          <span>
            <a href="https://github.com/nickthelegend/oboro" target="_blank" rel="noreferrer">GitHub</a> · MIT · © 2026 Nivesh Gajengi · Zcash Free Society Hack, Mumbai
          </span>
        </div>
      </footer>
    </div>
  );
}
