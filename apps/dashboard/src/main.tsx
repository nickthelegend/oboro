import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Landing } from './Landing';
import { Console } from './Console';
import { Shop } from './Shop';

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
  return hash.startsWith('#/console') ? 'console' : hash.startsWith('#/shop') ? 'shop' : 'landing';
}

function App() {
  const route = useRoute();
  return route === 'console' ? <Console /> : route === 'shop' ? <Shop /> : <Landing />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
