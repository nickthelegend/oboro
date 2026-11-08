import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Console } from './Console';
import { Wallet } from './Wallet';
import { Home } from './Home';
import { Store } from './Store';
import { Agent } from './Agent';
import './app.css';
import './relay.css';

function useRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  if (hash.startsWith('#/console')) return 'console';
  if (hash.startsWith('#/wallet')) return 'wallet';
  if (hash.startsWith('#/store') || hash.startsWith('#/shop')) return 'store';
  if (hash.startsWith('#/agent') || hash.startsWith('#/examples')) return 'examples';
  if (hash.startsWith('#/developers')) return 'developers';
  return 'home';
}

function App() {
  const route = useRoute();
  if (route === 'console') return <Console />;
  if (route === 'wallet') return <Wallet />;
  if (route === 'examples') return <Agent />;
  if (route === 'store') return <Store />;
  if (route === 'developers') return <Home section="developers" />;
  return <Home />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
