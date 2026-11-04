import { useEffect, useRef, useState } from 'react';
import { getState, type ConsoleState } from './api';

export type Proof = {
  label: string;
  recordedAt: string;
  txid: string;
  height?: number;
  priceZats: number;
  path: string;
  mixMs?: number;
  sellerSaw: string;
};

/** Polls the console server. `offline` means no console server answered (e.g. the static landing). */
export function useConsole(intervalMs = 2500) {
  const [state, setState] = useState<ConsoleState | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const tick = async () => {
      try {
        const s = await getState(ctrl.signal);
        if (!alive) return;
        setState(s);
        setOffline(null);
      } catch (e) {
        if (!alive) return;
        setOffline(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer.current = window.setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      alive = false;
      ctrl.abort();
      window.clearTimeout(timer.current);
    };
  }, [intervalMs]);

  return { state, offline };
}

/** A real recorded testnet run committed as public/proof.json (absent until one exists). */
export function useProof() {
  const [proof, setProof] = useState<Proof[] | null>(null);
  useEffect(() => {
    fetch('/proof.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => setProof(Array.isArray(p) && p.length ? p : null))
      .catch(() => setProof(null));
  }, []);
  return proof;
}
