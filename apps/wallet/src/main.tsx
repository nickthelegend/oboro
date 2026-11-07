import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Landing } from './Landing';
import { Console } from './Console';
import { Wallet } from './Wallet';
import { Example } from './Example';
import './app.css';

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
  if (hash.startsWith('#/wallet') || hash.startsWith('#/shop')) return 'wallet';
  if (hash.startsWith('#/examples')) return 'examples';
  return 'landing';
}

function App() {
  const route = useRoute();
  if (route === 'console') return <Console />;
  if (route === 'wallet') return <Wallet />;
  if (route === 'examples') return <Example />;
  return <Landing />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
